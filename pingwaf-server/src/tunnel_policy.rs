//! Tunnel policy: the bridge between the `tunnel_connectors` rows and what the
//! data planes and connectors are told.
//!
//! Two consumers share this module:
//!
//! * the rule bundle ([`bundle_tunnels`]) — every edge learns which tunnels it
//!   may accept, the SHA-256 of the credential to check, and the target list;
//! * the connector control stream ([`connector_config`]) — the connector learns
//!   the same policy plus the ingress endpoints and the certificate
//!   fingerprints to pin.
//!
//! Targets are derived, never stored: they are the distinct peer addresses of
//! the origin pools bound to the tunnel. Renaming a pool node or deleting a site
//! therefore changes the policy without a second table to keep in sync.

use std::collections::HashMap;

use rand::RngExt;
use sea_orm::ActiveModelTrait;
use sea_orm::{DatabaseConnection, DbErr, EntityTrait, Set};
use uuid::Uuid;

use pingwaf_proto::control_plane as proto;

use crate::models::{
    agent as agents, site_upstream_pools, site_upstreams,
    tunnel_connector as tunnel_connectors, tunnel_setting as tunnel_settings,
    tunnel_status,
};

/// Primary key of the single settings row.
pub const SETTINGS_ID: i32 = 1;

/// A fresh 32-byte secret, hex encoded.
///
/// Used for both the pairing token and the long-lived connector credential.
/// 256 bits of randomness is why a plain SHA-256 is the right storage: there is
/// nothing to guess, and the digest is what has to travel to the edges.
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    hex::encode(bytes)
}

/// SHA-256 of a secret, lower-case hex.
pub fn digest_hex(secret: &str) -> String {
    pingwaf_tunnel::protocol::credential_digest(secret)
}

/// Loads the global tunnel settings, creating the default row on first use.
pub async fn load_settings(
    db: &DatabaseConnection,
) -> Result<tunnel_settings::Model, DbErr> {
    if let Some(row) = tunnel_settings::Entity::find_by_id(SETTINGS_ID)
        .one(db)
        .await?
    {
        return Ok(row.sanitized());
    }
    let now = chrono::Utc::now();
    let active = tunnel_settings::ActiveModel {
        id: Set(SETTINGS_ID),
        enabled: Set(true),
        pairing_ttl_seconds: Set(1800),
        max_streams_per_session: Set(256),
        max_targets_per_tunnel: Set(256),
        idle_timeout_seconds: Set(300),
        heartbeat_seconds: Set(20),
        session_token_ttl_seconds: Set(3600),
        updated_at: Set(now),
    };
    Ok(active.insert(db).await?.sanitized())
}

/// Distinct targets of every tunnel, keyed by tunnel id.
///
/// A pool with no tunnel contributes nothing; a peer address that is not a
/// valid `host:port` is dropped rather than handed to a connector's dialer.
pub async fn targets_by_tunnel(
    db: &DatabaseConnection,
) -> Result<HashMap<Uuid, Vec<String>>, DbErr> {
    let pools = site_upstream_pools::Entity::find().all(db).await?;
    let peers = site_upstreams::Entity::find().all(db).await?;
    let pool_tunnel: HashMap<Uuid, Uuid> = pools
        .into_iter()
        .filter_map(|pool| pool.tunnel_id.map(|tunnel| (pool.id, tunnel)))
        .collect();
    let mut targets: HashMap<Uuid, Vec<String>> = HashMap::new();
    for peer in peers {
        let Some(tunnel_id) = pool_tunnel.get(&peer.pool_id).copied() else {
            continue;
        };
        let Some(address) =
            pingwaf_tunnel::protocol::normalize_target(&peer.address)
        else {
            continue;
        };
        let entry = targets.entry(tunnel_id).or_default();
        if !entry.iter().any(|existing| existing == &address) {
            entry.push(address);
        }
    }
    for list in targets.values_mut() {
        list.sort();
    }
    Ok(targets)
}

/// Targets of one tunnel, capped by the deployment limit.
pub async fn targets_for_tunnel(
    db: &DatabaseConnection,
    tunnel_id: Uuid,
) -> Result<Vec<String>, DbErr> {
    let settings = load_settings(db).await?;
    let all = targets_by_tunnel(db).await?;
    let mut all = all;
    let mut targets = all.remove(&tunnel_id).unwrap_or_default();
    let limit = settings.max_targets_per_tunnel.max(1) as usize;
    if targets.len() > limit {
        tracing::warn!(
            %tunnel_id,
            targets = targets.len(),
            limit,
            "tunnel advertises more targets than the deployment limit; truncating"
        );
        targets.truncate(limit);
    }
    Ok(targets)
}

/// Domains of the sites whose origin pools are bound to each tunnel.
///
/// Used by the console to answer "what breaks if I disable/delete this?", so a
/// destructive action can name its blast radius instead of a count.
pub async fn sites_by_tunnel(
    db: &DatabaseConnection,
) -> Result<HashMap<Uuid, Vec<String>>, DbErr> {
    let pools = site_upstream_pools::Entity::find().all(db).await?;
    let sites = crate::models::site::Entity::find().all(db).await?;
    let domains: HashMap<Uuid, String> =
        sites.into_iter().map(|row| (row.id, row.domain)).collect();
    let mut by_tunnel: HashMap<Uuid, Vec<String>> = HashMap::new();
    for pool in pools {
        let Some(tunnel_id) = pool.tunnel_id else {
            continue;
        };
        let Some(domain) = domains.get(&pool.site_id) else {
            continue;
        };
        let entry = by_tunnel.entry(tunnel_id).or_default();
        if !entry.iter().any(|existing| existing == domain) {
            entry.push(domain.clone());
        }
    }
    for list in by_tunnel.values_mut() {
        list.sort();
    }
    Ok(by_tunnel)
}

/// Ingress endpoints connectors should dial, grouped by public address.
///
/// An agent contributes when the operator gave it a public address *and* it
/// reported a certificate fingerprint: without a fingerprint a connector cannot
/// verify the edge, and an unverifiable ingress is not offered.
pub async fn ingress_endpoints(
    db: &DatabaseConnection,
) -> Result<Vec<proto::TunnelIngress>, DbErr> {
    let rows = agents::Entity::find().all(db).await?;
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (Some(addr), Some(fingerprint)) = (
            row.tunnel_ingress_addr.as_deref().map(str::trim),
            row.tunnel_cert_sha256.as_deref().map(str::trim),
        ) else {
            continue;
        };
        if addr.is_empty() || fingerprint.is_empty() {
            continue;
        }
        let entry = grouped.entry(addr.to_string()).or_default();
        if !entry.iter().any(|existing| existing == fingerprint) {
            entry.push(fingerprint.to_string());
        }
    }
    let mut endpoints: Vec<proto::TunnelIngress> = grouped
        .into_iter()
        .map(|(endpoint, fingerprints)| proto::TunnelIngress {
            endpoint,
            fingerprints,
        })
        .collect();
    endpoints.sort_by(|a, b| a.endpoint.cmp(&b.endpoint));
    Ok(endpoints)
}

/// The tunnel list and the limits, as the rule bundle carries them.
pub async fn bundle_tunnels(
    db: &DatabaseConnection,
) -> Result<(Vec<proto::TunnelConfig>, proto::TunnelSettings), DbErr> {
    let settings = load_settings(db).await?;
    let targets = targets_by_tunnel(db).await?;
    let rows = tunnel_connectors::Entity::find().all(db).await?;
    let mut tunnels = Vec::with_capacity(rows.len());
    for row in rows {
        let mut targets = targets.get(&row.id).cloned().unwrap_or_default();
        let limit = settings.max_targets_per_tunnel.max(1) as usize;
        if targets.len() > limit {
            targets.truncate(limit);
        }
        tunnels.push(proto::TunnelConfig {
            tunnel_id: row.id.to_string(),
            name: row.name,
            // The edges verify a signature; they never receive the connector's
            // credential or its digest.
            session_public_key: crate::tunnel_token::public_key_hex(),
            // A tunnel that was never paired, or that an operator disabled,
            // is not accepted by an edge even though the row still exists.
            enabled: settings.enabled && row.status != tunnel_status::DISABLED,
            targets,
        });
    }
    tunnels.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((
        tunnels,
        proto::TunnelSettings {
            max_streams: settings.max_streams_per_session.max(1) as u32,
            idle_timeout_secs: settings.idle_timeout_seconds.max(10) as u32,
            heartbeat_secs: settings.heartbeat_seconds.max(5) as u32,
            session_token_ttl_secs: settings.session_token_ttl_seconds.max(60)
                as u32,
        },
    ))
}

/// The policy pushed to one connector.
pub async fn connector_config(
    db: &DatabaseConnection,
    tunnel_id: Uuid,
) -> Result<Option<proto::TunnelConnectorConfig>, DbErr> {
    let Some(row) = tunnel_connectors::Entity::find_by_id(tunnel_id)
        .one(db)
        .await?
    else {
        return Ok(None);
    };
    let settings = load_settings(db).await?;
    // Every push carries a freshly minted token: the connector must never have
    // to ask for one on the data path, and a rotating token is what bounds a
    // revoked tunnel's reach on a partitioned edge.
    let (session_token, session_token_expires_at) = crate::tunnel_token::mint(
        &tunnel_id.to_string(),
        settings.session_token_ttl_seconds.max(60) as u64,
    )
    .map_err(|err| sea_orm::DbErr::Custom(err.to_string()))?;
    Ok(Some(proto::TunnelConnectorConfig {
        ingress: ingress_endpoints(db).await?,
        targets: targets_for_tunnel(db, tunnel_id).await?,
        settings: Some(proto::TunnelSettings {
            max_streams: settings.max_streams_per_session.max(1) as u32,
            idle_timeout_secs: settings.idle_timeout_seconds.max(10) as u32,
            heartbeat_secs: settings.heartbeat_seconds.max(5) as u32,
            session_token_ttl_secs: settings.session_token_ttl_seconds.max(60)
                as u32,
        }),
        enabled: settings.enabled && row.status != tunnel_status::DISABLED,
        session_token,
        session_token_expires_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_secrets_are_256_bits_of_hex() {
        let first = generate_secret();
        let second = generate_secret();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn a_digest_is_stable_and_distinguishes_secrets() {
        let digest = digest_hex("secret");
        assert_eq!(digest, digest_hex("secret"));
        assert_ne!(digest, digest_hex("secret2"));
        assert_eq!(digest.len(), 64);
        assert!(pingwaf_tunnel::protocol::credential_matches(
            "secret", &digest
        ));
        assert!(!pingwaf_tunnel::protocol::credential_matches(
            "other", &digest
        ));
    }
}
