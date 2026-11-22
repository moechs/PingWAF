import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from 'd3-geo'
import { useTranslation } from 'react-i18next'
import { Pause, Play } from '@phosphor-icons/react'
import { countryFlag } from '@/api/geo'
import type { GeoCountryStat } from '@/api/types'
import { countryName } from '@/lib/countryNames'
import { countryTrafficRows, type CountryTrafficRow } from '@/lib/trafficSeries'
import { ISO_NUMERIC_TO_ALPHA2 } from './isoNumeric'
import { formatCompactNumber, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { COUNTRY_CENTROIDS, worldFeatures } from './world'

const SIZE = 360
const RADIUS = SIZE / 2 - 12
/** Degrees per second of the idle auto-rotation. */
const ROTATE_DEG_PER_SECOND = 6
/**
 * Rotation is re-projected at most every 80 ms (~12 fps). One frame costs
 * ~4 ms for the 110 m topology, so this caps the globe at ~5 % of a core while
 * still reading as a smooth 6°/s spin.
 */
const FRAME_MS = 80
/** Degrees of rotation per pixel dragged. */
const DRAG_DEG_PER_PX = 0.35
const MIN_PHI = -70
const MAX_PHI = 70
/** Heat ladder over the brand colour, matched to the old choropleth. */
const HEAT_OPACITY = [0.18, 0.38, 0.58, 0.78, 0.95]

interface GlobeMarker extends CountryTrafficRow {
  x: number
  y: number
  r: number
}

interface LandShape {
  key: string
  d: string
  opacity: number
}

function wrapLambda(value: number): number {
  return (((value + 180) % 360) + 360) % 360 - 180
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function heatOpacity(requests: number, max: number): number {
  if (requests <= 0 || max <= 0) return 0
  const step = Math.min(
    HEAT_OPACITY.length - 1,
    Math.floor((Math.sqrt(requests) / Math.sqrt(max)) * HEAT_OPACITY.length),
  )
  return HEAT_OPACITY[step]
}

/** `prefers-reduced-motion`, live — the globe stops rotating when it flips. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Animated 3D globe of requests per country.
 *
 * Rendered as plain SVG with an orthographic `d3-geo` projection — no WebGL,
 * no canvas, no new dependency — so it works in every browser the dashboard
 * supports and prints/zooms like any other chart. Countries with traffic are
 * tinted by a sqrt heat ladder and topped with a bubble sized by requests;
 * bubbles on the far hemisphere are dropped, which is what makes the rotation
 * read as a sphere rather than a spinning map.
 *
 * Interaction: idle auto-rotation (pausable, and off under
 * `prefers-reduced-motion`), drag/pointer rotation, arrow-key rotation, and a
 * hover tooltip per bubble. The same data is mirrored into a screen-reader
 * list, and the globe falls back to a plain ranking if the bundled topology is
 * ever unavailable.
 */
export function GlobeChart({
  data,
  className,
}: {
  data: GeoCountryStat[]
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const language = i18n?.language ?? 'en'
  const rows = useMemo(() => countryTrafficRows(data), [data])
  const max = rows.length > 0 ? rows[0].requests : 0

  const reducedMotion = usePrefersReducedMotion()
  // `prefers-reduced-motion` wins over the toggle, so no state has to be
  // rewritten when the OS setting flips mid-session.
  const [paused, setPaused] = useState(false)
  const rotating = !paused && !reducedMotion

  const [rotation, setRotation] = useState<[number, number]>([-12, -18])
  const [hover, setHover] = useState<GlobeMarker | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lambda: number
    phi: number
  } | null>(null)
  const hoveringRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(true)

  // Stop burning frames once the card is scrolled out of view.
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      visibleRef.current = entries.some((entry) => entry.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Idle rotation. Frame-rate independent: the step comes from the elapsed
  // time, so a background tab that throttles rAF does not slow the globe down.
  useEffect(() => {
    if (!rotating) return
    let frame = 0
    let last = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (last === 0) {
        last = now
        return
      }
      const elapsed = now - last
      if (elapsed < FRAME_MS) return
      last = now
      // Dragging or hovering a bubble holds the globe still so the tooltip
      // does not slide out from under the pointer.
      if (dragRef.current || hoveringRef.current || !visibleRef.current) return
      if (typeof document !== 'undefined' && document.hidden) return
      setRotation(([lambda, phi]) => [
        wrapLambda(lambda + (elapsed / 1000) * ROTATE_DEG_PER_SECOND),
        phi,
      ])
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [rotating])

  const geometry = useMemo(() => {
    const projection = geoOrthographic()
      .scale(RADIUS)
      .translate([SIZE / 2, SIZE / 2])
      .rotate([rotation[0], rotation[1], 0])
      .clipAngle(90)
    const path = geoPath(projection)
    const viewCentre: [number, number] = [-rotation[0], -rotation[1]]
    const requestsByCode = new Map(rows.map((row) => [row.code, row.requests]))

    const land: LandShape[] = []
    for (const shape of worldFeatures.features) {
      const d = path(shape)
      if (!d) continue
      const id = String(shape.id ?? '')
      const code = ISO_NUMERIC_TO_ALPHA2[id] ?? ''
      land.push({
        key: id || d.slice(0, 40),
        d,
        opacity: heatOpacity(requestsByCode.get(code) ?? 0, max),
      })
    }

    const markers: GlobeMarker[] = []
    for (const row of rows) {
      const centroid = COUNTRY_CENTROIDS.get(row.code)
      if (!centroid) continue
      // Back of the sphere: geoDistance > 90° from the projection centre.
      if (geoDistance(centroid, viewCentre) > Math.PI / 2) continue
      const point = projection(centroid)
      if (!point) continue
      markers.push({
        ...row,
        x: point[0],
        y: point[1],
        r: 3 + 9 * Math.sqrt(max > 0 ? row.requests / max : 0),
      })
    }
    markers.sort((a, b) => b.r - a.r)

    return {
      sphere: path({ type: 'Sphere' }) ?? '',
      graticule: path(geoGraticule10()) ?? '',
      land,
      markers,
    }
  }, [rotation, rows, max])

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lambda: rotation[0],
      phi: rotation[1],
    }
    // A drag re-projects the bubbles; a tooltip left open would then point at
    // a marker that has moved (pointer capture suppresses the leave event).
    hoveringRef.current = false
    setHover(null)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // The pointer is already gone (fast tap): rotation still works.
    }
  }

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    setRotation([
      wrapLambda(drag.lambda + dx * DRAG_DEG_PER_PX),
      clamp(drag.phi - dy * DRAG_DEG_PER_PX, MIN_PHI, MAX_PHI),
    ])
  }

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? 30 : 10
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        setRotation(([lambda, phi]) => [wrapLambda(lambda - step), phi])
        break
      case 'ArrowRight':
        event.preventDefault()
        setRotation(([lambda, phi]) => [wrapLambda(lambda + step), phi])
        break
      case 'ArrowUp':
        event.preventDefault()
        setRotation(([lambda, phi]) => [lambda, clamp(phi + step, MIN_PHI, MAX_PHI)])
        break
      case 'ArrowDown':
        event.preventDefault()
        setRotation(([lambda, phi]) => [lambda, clamp(phi - step, MIN_PHI, MAX_PHI)])
        break
      default:
        break
    }
  }

  const hasGeometry = worldFeatures.features.length > 0

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {hasGeometry ? (
        <div className="relative mx-auto w-full" style={{ maxWidth: SIZE }}>
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block h-auto w-full touch-none select-none"
            role="img"
            aria-label={t('pages.traffic.geoMap.globeLabel')}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={(event) => {
              endDrag(event)
              hoveringRef.current = false
              setHover(null)
            }}
            onKeyDown={handleKeyDown}
          >
            <path
              d={geometry.sphere}
              fill="var(--color-bg-recessed)"
              stroke="var(--color-border-line)"
              strokeWidth={1}
            />
            <path
              d={geometry.graticule}
              fill="none"
              stroke="var(--color-border-line)"
              strokeWidth={0.4}
              opacity={0.7}
            />
            <g pointerEvents="none">
              {geometry.land.map((shape) => (
                <path
                  key={shape.key}
                  d={shape.d}
                  fill={
                    shape.opacity > 0
                      ? 'var(--color-bg-brand)'
                      : 'var(--color-bg-elevated)'
                  }
                  fillOpacity={shape.opacity > 0 ? shape.opacity : 1}
                  stroke="var(--color-border-line)"
                  strokeWidth={0.5}
                />
              ))}
            </g>
            {geometry.markers.map((marker) => (
              <circle
                key={marker.code}
                cx={marker.x}
                cy={marker.y}
                r={marker.r}
                fill="var(--color-bg-brand)"
                fillOpacity={hover?.code === marker.code ? 0.95 : 0.6}
                stroke="var(--color-bg-brand)"
                strokeWidth={1}
                className="cursor-pointer"
                onPointerEnter={() => {
                  hoveringRef.current = true
                  setHover(marker)
                }}
                onPointerLeave={() => {
                  hoveringRef.current = false
                  setHover((current) => (current?.code === marker.code ? null : current))
                }}
              >
                <title>
                  {`${countryName(marker.code, language)} · ${formatNumber(marker.requests)}`}
                </title>
              </circle>
            ))}
          </svg>

          {hover && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap rounded-md border border-line bg-elevated px-2.5 py-1.5 text-xs shadow-lg"
              style={{
                // Clamped so a marker near the limb does not push the tooltip
                // outside the card and create a horizontal scrollbar.
                left: `${Math.min(76, Math.max(24, (hover.x / SIZE) * 100))}%`,
                top: `${(hover.y / SIZE) * 100}%`,
              }}
            >
              <span className="mr-1.5">{countryFlag(hover.code)}</span>
              <span className="font-medium text-fg-strong">
                {countryName(hover.code, language)}
              </span>
              <span className="ml-2 tabular-nums text-fg">
                {formatNumber(hover.requests)}
              </span>
              <span className="ml-1.5 tabular-nums text-fg-subtle">
                {formatPercent(hover.share)}
              </span>
            </div>
          )}
        </div>
      ) : (
        // No topology available (unexpected, but the dashboard must not show a
        // blank card): fall back to the plain ranking.
        <ol className="flex flex-col gap-1 text-xs">
          {rows.map((row) => (
            <li key={row.code} className="flex items-center gap-2">
              <span>{countryFlag(row.code)}</span>
              <span className="min-w-0 flex-1 truncate text-fg">
                {countryName(row.code, language)}
              </span>
              <span className="tabular-nums text-fg-subtle">
                {formatCompactNumber(row.requests)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-snug text-fg-subtle">
          {t('pages.traffic.geoMap.globeHint')}
        </p>
        {hasGeometry && !reducedMotion && (
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            aria-pressed={rotating}
            aria-label={t(
              rotating
                ? 'pages.traffic.geoMap.pauseRotation'
                : 'pages.traffic.geoMap.resumeRotation',
            )}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line text-fg-subtle transition-colors hover:bg-recessed hover:text-fg"
          >
            {rotating ? (
              <Pause weight="fill" className="h-3.5 w-3.5" />
            ) : (
              <Play weight="fill" className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* The accessible equivalent of the picture: every country, in order. */}
      <ul className="sr-only">
        {rows.map((row) => (
          <li key={row.code}>
            {countryName(row.code, language)} ({row.code}):{' '}
            {formatNumber(row.requests)} {t('pages.traffic.requests')},{' '}
            {formatPercent(row.share)}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default GlobeChart