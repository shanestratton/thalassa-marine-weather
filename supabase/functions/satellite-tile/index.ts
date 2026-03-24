// supabase/functions/satellite-tile/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// NASA GIBS IR layers for the geostationary ring (global coverage)
const SATELLITE_LAYERS: Record<string, string> = {
  'himawari': 'Himawari_AHI_Band13_Clean_Infrared',
  'goes-west': 'GOES-West_ABI_Band13_Clean_Infrared',
  'goes-east': 'GOES-East_ABI_Band13_Clean_Infrared',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const url = new URL(req.url)
    const zoom = Math.min(parseInt(url.searchParams.get("zoom") || url.searchParams.get("z") || "5"), 6)

    // Satellite selector: himawari (default), goes-west, goes-east
    const satParam = url.searchParams.get("sat") || "himawari"
    const layerName = SATELLITE_LAYERS[satParam] || SATELLITE_LAYERS['himawari']

    // Support both modes:
    //   1. Tile coordinates: x, y, z (for Mapbox raster source)
    //   2. Lat/lon: lat, lon, zoom (original mode)
    let xTile: number
    let yTile: number

    const xParam = url.searchParams.get("x")
    const yParam = url.searchParams.get("y")

    if (xParam !== null && yParam !== null) {
      // Direct tile coordinates (from Mapbox {x}/{y}/{z} substitution)
      xTile = parseInt(xParam)
      yTile = parseInt(yParam)
    } else {
      // Calculate from lat/lon (Web Mercator Math)
      const lat = parseFloat(url.searchParams.get("lat") || "-27.20")
      const lon = parseFloat(url.searchParams.get("lon") || "153.10")
      const n = Math.pow(2, zoom)
      xTile = Math.floor(((lon + 180) / 360) * n)
      yTile = Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n
      )
    }

    // NASA GIBS near-real-time data lags 3-24 hours.
    // Try today (UTC) → yesterday → 2 days ago.
    const now = Date.now()
    const d0 = new Date(now).toISOString().split('T')[0]
    const d1 = new Date(now - 86400000).toISOString().split('T')[0]
    const d2 = new Date(now - 172800000).toISOString().split('T')[0]

    // Build NASA WMTS URL for a given date
    const base = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi"
    const params = `Service=WMTS&Request=GetTile&Version=1.0.0`
      + `&Layer=${layerName}`
      + `&Style=default&TileMatrixSet=GoogleMapsCompatible_Level6`
      + `&TileMatrix=${zoom}&TileRow=${yTile}&TileCol=${xTile}`
      + `&Format=image%2Fpng`

    // Try today first
    let response = await fetch(`${base}?${params}&Time=${d0}`)
    let usedDate = d0

    // Fallback to yesterday
    if (!response.ok) {
      response = await fetch(`${base}?${params}&Time=${d1}`)
      usedDate = d1
    }

    // Fallback to 2 days ago
    if (!response.ok) {
      response = await fetch(`${base}?${params}&Time=${d2}`)
      usedDate = d2
    }

    if (!response.ok) {
      throw new Error(`NASA GIBS ${satParam} unavailable: ${response.status}`)
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
