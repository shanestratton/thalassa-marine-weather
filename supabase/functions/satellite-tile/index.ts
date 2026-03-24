// supabase/functions/satellite-tile/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const url = new URL(req.url)
    const zoom = Math.min(parseInt(url.searchParams.get("zoom") || url.searchParams.get("z") || "5"), 6)

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

    // NASA KVP Construction — Geostationary Ring (global IR coverage)
    const today = new Date().toISOString().split('T')[0]
    const nasaUrl = new URL("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi")

    nasaUrl.searchParams.set("Service", "WMTS")
    nasaUrl.searchParams.set("Request", "GetTile")
    nasaUrl.searchParams.set("Version", "1.0.0")
    nasaUrl.searchParams.set("Layer", "Himawari_AHI_Band13_Clean_Infrared")
    nasaUrl.searchParams.set("Style", "default")
    nasaUrl.searchParams.set("TileMatrixSet", "GoogleMapsCompatible_Level6")
    nasaUrl.searchParams.set("TileMatrix", zoom.toString())
    nasaUrl.searchParams.set("TileRow", yTile.toString())
    nasaUrl.searchParams.set("TileCol", xTile.toString())
    nasaUrl.searchParams.set("Format", "image/png")
    nasaUrl.searchParams.set("Time", today)

    // Fetch from NASA
    const response = await fetch(nasaUrl.toString())

    if (!response.ok) throw new Error(`NASA Error: ${response.status}`)

    const imageBlob = await response.blob()

    return new Response(imageBlob, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=600",
      },
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
