// supabase/functions/satellite-tile/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Satellite imagery sources ──
// GMGSI: NOAA Global Mosaic of Geostationary Satellite Imagery
//   - Seamless worldwide blend of GOES-East + GOES-West + Himawari + Meteosat
//   - Longwave IR (Band 13) for cloud/storm visualization
// Individual: NASA GIBS layers for targeted satellite imagery
const SATELLITE_LAYERS: Record<string, { type: 'gibs' | 'nowcoast'; layer: string; sublayer?: number }> = {
  // NASA GIBS individual satellites
  'himawari': { type: 'gibs', layer: 'Himawari_AHI_Band13_Clean_Infrared' },
  'goes-west': { type: 'gibs', layer: 'GOES-West_ABI_Band13_Clean_Infrared' },
  'goes-east': { type: 'gibs', layer: 'GOES-East_ABI_Band13_Clean_Infrared' },
  // NOAA nowCOAST GMGSI — seamless global composite (preferred)
  'gmgsi': { type: 'nowcoast', layer: 'sat_meteo_imagery_time', sublayer: 9 },
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const url = new URL(req.url)
    const zoom = Math.min(parseInt(url.searchParams.get("zoom") || url.searchParams.get("z") || "5"), 8)

    const satParam = url.searchParams.get("sat") || "gmgsi"
    const config = SATELLITE_LAYERS[satParam] || SATELLITE_LAYERS['gmgsi']

    // Support tile coordinates (x, y, z) or lat/lon
    let xTile: number
    let yTile: number

    const xParam = url.searchParams.get("x")
    const yParam = url.searchParams.get("y")

    if (xParam !== null && yParam !== null) {
      xTile = parseInt(xParam)
      yTile = parseInt(yParam)
    } else {
      const lat = parseFloat(url.searchParams.get("lat") || "-27.20")
      const lon = parseFloat(url.searchParams.get("lon") || "153.10")
      const n = Math.pow(2, zoom)
      xTile = Math.floor(((lon + 180) / 360) * n)
      yTile = Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n
      )
    }

    let response: Response
    let usedDate = ''

    if (config.type === 'nowcoast') {
      // ── NOAA nowCOAST ArcGIS tile service (GMGSI) ──
      // Convert XYZ tile to bbox for WMS export
      const n = Math.pow(2, zoom)
      const lon1 = (xTile / n) * 360 - 180
      const lon2 = ((xTile + 1) / n) * 360 - 180
      const lat1Rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (yTile + 1) / n)))
      const lat2Rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * yTile / n)))
      const lat1 = lat1Rad * 180 / Math.PI
      const lat2 = lat2Rad * 180 / Math.PI

      // Use Web Mercator (EPSG:3857) projection for bbox
      const toMerc = (lon: number, lat: number) => {
        const x = lon * 20037508.34 / 180
        const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180
        return { x, y }
      }
      const bl = toMerc(lon1, lat1)
      const tr = toMerc(lon2, lat2)

      const exportUrl = `https://nowcoast.noaa.gov/arcgis/rest/services/nowcoast/${config.layer}/MapServer/export`
        + `?bbox=${bl.x},${bl.y},${tr.x},${tr.y}`
        + `&bboxSR=3857&imageSR=3857`
        + `&size=512,512`
        + `&format=png32`
        + `&transparent=true`
        + `&layers=show:${config.sublayer}`
        + `&f=image`

      response = await fetch(exportUrl)
      usedDate = new Date().toISOString().split('T')[0]
    } else {
      // ── NASA GIBS (individual satellites) ──
      const now = Date.now()
      const d0 = new Date(now).toISOString().split('T')[0]
      const d1 = new Date(now - 86400000).toISOString().split('T')[0]
      const d2 = new Date(now - 172800000).toISOString().split('T')[0]

      const base = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi"
      const params = `Service=WMTS&Request=GetTile&Version=1.0.0`
        + `&Layer=${config.layer}`
        + `&Style=default&TileMatrixSet=GoogleMapsCompatible_Level6`
        + `&TileMatrix=${zoom}&TileRow=${yTile}&TileCol=${xTile}`
        + `&Format=image%2Fpng`

      response = await fetch(`${base}?${params}&Time=${d0}`)
      usedDate = d0

      if (!response.ok) {
        response = await fetch(`${base}?${params}&Time=${d1}`)
        usedDate = d1
      }
      if (!response.ok) {
        response = await fetch(`${base}?${params}&Time=${d2}`)
        usedDate = d2
      }
    }

    if (!response.ok) {
      throw new Error(`Satellite ${satParam} unavailable: ${response.status}`)
    }

    const imageBlob = await response.blob()

    return new Response(imageBlob, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=600",
        "X-Satellite-Date": usedDate,
        "X-Satellite-Source": satParam,
      },
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
