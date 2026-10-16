"""Actual pinned-GDAL synthetic ROI/NoData/overview regression; no public inputs."""
import tempfile
from pathlib import Path
import numpy as np
from osgeo import gdal, osr

from nz_render import inspect_source, source_window

gdal.UseExceptions()
gdal.SetCacheMax(32*1024*1024)
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory)/'synthetic.tif'
    ds = gdal.GetDriverByName('GTiff').Create(str(path), 1024, 1024, 1, gdal.GDT_Float32)
    ds.SetGeoTransform((1700000, 1, 0, 5900000, 0, -1))
    native = osr.SpatialReference()
    native.ImportFromEPSG(2193)
    native.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ds.SetProjection(native.ExportToWkt())
    values = np.full((1024, 1024), -25, dtype='float32')
    values[384:640, 384:640] = -9999
    band = ds.GetRasterBand(1)
    band.SetNoDataValue(-9999)
    band.WriteArray(values)
    ds.BuildOverviews('AVERAGE', [2, 4, 8, 16, 32])
    ds = None
    metadata = inspect_source(path)
    if metadata['nodata'] != -9999 or metadata['coarseSeafloorPixels'] <= 0:
        raise ValueError('Actual GDAL metadata/finite source proof failed')
    merc = osr.SpatialReference()
    merc.ImportFromEPSG(3857)
    merc.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    options = osr.CoordinateTransformationOptions()
    options.SetBallparkAllowed(False)
    options.SetOnlyBest(True)
    transform = osr.CreateCoordinateTransformation(native, merc, options)
    corners = [transform.TransformPoint(x, y) for x in (1700000,1701024) for y in (5898976,5900000)]
    bounds = [min(p[0] for p in corners), min(p[1] for p in corners),
              max(p[0] for p in corners), max(p[1] for p in corners)]
    spent = [0]
    result = source_window({'path': str(path)}, bounds, 256, 256, spent)
    if result.shape != (256, 256) or not (0 < spent[0] < 256_000_000):
        raise ValueError('Actual clipped decoded ROI cap failed')
    if not np.isnan(result[128,128]) or not np.isclose(result[32,32], -25):
        raise ValueError('Actual GDAL warp turned a missing source cell into finite water')
    print({'passed': True, 'decodedRoiBytes': spent[0], 'missingPixels': int(np.isnan(result).sum()),
           'finitePixels': int(np.isfinite(result).sum()), 'gdal': gdal.VersionInfo('--version')})
