"""Reviewed NOAA conversion runtime. These constants do not activate any service."""
GDAL_MANIFEST = 'sha256:44fee7d4f9be0966851d7b14a0a387216897d8347f9e0ebc4e812f7217bc39d6'
GDAL_CONFIG = 'sha256:1a5c76ce004ab61c5d49d4d1341eec5e61d68e21ed4abf213851bf3ed274b5f5'
GDAL_VERSION = '3.13.3'
IMAGE_ID = 'sha256:94c4c37740585d2a911cd5336366986ff13ae777f540458297fcefb4c359e048'
CONVERTER_SHA = 'aa4aa33d0033d6611dd102baaae98810213f37727d5ff4d00f5274d7081ed151'


def verify_runtime_policy(image, converter):
    if image != IMAGE_ID or converter != CONVERTER_SHA:
        raise ValueError('NOAA runtime is outside the reviewed stable GDAL3.13.3 image/converter policy')
