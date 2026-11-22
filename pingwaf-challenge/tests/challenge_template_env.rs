//! Verifies that the environment-selected template is actually used and that
//! the compiled challenge script is still injected. This lives in its own test
//! binary so the process-global `OnceLock` cannot see another test's env.

use pingwaf_challenge::js_challenge::page::{
    generate_js_challenge_html, ChallengePageParams,
};

#[test]
fn env_template_is_used_and_compiled_scripts_are_injected() {
    let template = r#"<!DOCTYPE html>
<html><head><title>{{BRAND_NAME}}</title></head><body>
<div id="countdown"></div>
<h1 id="title"></h1>
<p id="subtitle"></p>
<div id="status"></div>
<div id="spinnerWrap"></div>
<div id="progressBar"><div id="progressFill"></div></div>
<p>{{BRAND_NAME}} / {{REQUEST_ID}}</p>
{{PINGWAF_SCRIPTS}}
</body></html>"#;
    let path = std::env::temp_dir().join(format!(
        "pingwaf-challenge-template-{}.html",
        std::process::id()
    ));
    std::fs::write(&path, template).unwrap();
    // SAFETY: this integration-test binary contains one test, so no other
    // thread reads or writes the process environment concurrently.
    unsafe {
        std::env::set_var("PINGWAF_CHALLENGE_TEMPLATE", &path);
    }

    let params = ChallengePageParams {
        request_id: "env-ray".to_string(),
        brand_name: "Env Brand".to_string(),
        ..Default::default()
    };
    let html = generate_js_challenge_html(&params);
    let _ = std::fs::remove_file(&path);

    assert!(html.contains("Env Brand"));
    assert!(html.contains("env-ray"));
    assert!(
        html.contains("computeProofOfWork"),
        "the compiled proof-of-work must be injected into the custom template"
    );
    assert!(
        !html.contains("Checking your browser"),
        "the custom template must replace the built-in presentation"
    );
}
