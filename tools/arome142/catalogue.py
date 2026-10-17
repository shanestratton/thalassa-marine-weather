"""Original AROME-OM source plans. Standard library, no network or publication.

The exact data.gouv metadata must enumerate all49 SP1 packets for the requested
original model run. A box, metadata200 or another French/global model does not
qualify a sea point. Actual native mask/GRIB admission is a separate prerequisite.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

HOST = 'meteofrance-pnt.s3.rbx.io.cloud.ovh.net'
MAX_CATALOGUE_BYTES = 4 * 1024 * 1024
MAX_PACKET_BYTES = 16 * 1024 * 1024
MAX_COHORT_BYTES = 512 * 1024 * 1024
MAX_DAY_BYTES = 2_500_000_000
HOURS = 49
DOMAINS = {
    'NCALED': {
        'model': 'thalassa_arome_om_ncaled_025', 'grid': 'NCALED',
        'catalogue': '65bd14cca6919e97e9699b09',
        'bounds': [-26, -13.75, 158.5, 171.5], 'width': 521, 'height': 491,
        'cycles': [0, 6, 12, 18],
    },
    'ANTIL': {
        'model': 'thalassa_arome_om_caraib_025', 'grid': 'CARAIB',
        'catalogue': '65bd162b9dc0d31edfabc2b9',
        'bounds': [9.7, 22.9, -75.3, -51.7], 'width': 945, 'height': 529,
        'cycles': [0, 6, 12, 18],
    },
    'POLYN': {
        'model': 'thalassa_arome_om_polyn_025', 'grid': 'POLYN',
        'catalogue': '65bd1509cc112e6a1458ab95',
        'bounds': [-25.25, -12.6, -157.5, -144.5], 'width': 521, 'height': 507,
        # The current official catalogue describes two daily publications.
        'cycles': [0, 12],
    },
}


class AdmissionError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AdmissionError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def original_run(value, domain, now):
    require(domain in DOMAINS, 'unknown AROME-OM domain')
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:00:00Z', value),
            'original UTC run is required')
    try:
        run = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise AdmissionError('invalid original model date') from error
    require(run.strftime('%Y-%m-%dT%H:00:00Z') == value, 'invalid original model date')
    require(run.hour in DOMAINS[domain]['cycles'], 'unadmitted regional cycle')
    require(now.tzinfo is not None, 'current clock must be timezone aware')
    age = (now.astimezone(timezone.utc) - run).total_seconds()
    require(0 <= age <= 18 * 3600, 'original model run is future or stale')
    return run


def packet_url(domain, run_utc, offset):
    require(domain in DOMAINS and type(offset) is int and 0 <= offset < HOURS,
            'unadmitted regional packet')
    require(isinstance(run_utc, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:00:00Z', run_utc),
            'invalid packet clock')
    name = f'arome-om-{domain}__0025__SP1__{offset:03d}H__{run_utc}.grib2'
    return f'https://{HOST}/pnt/{run_utc}/arome-om/{domain}/0025/SP1/{name}'


def build_plan(raw, domain, run_utc, now=None):
    """Pure offline plan. No latest-run selection, redirects or URL overrides."""
    now = now or datetime.now(timezone.utc)
    original_run(run_utc, domain, now)
    require(type(raw) is bytes and len(raw) <= MAX_CATALOGUE_BYTES, 'catalogue byte limit')
    try:
        catalogue = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise AdmissionError('invalid catalogue JSON') from error
    require(isinstance(catalogue, dict), 'catalogue must be an object')
    spec = DOMAINS[domain]
    require(catalogue.get('id') == spec['catalogue'] and catalogue.get('license') == 'lov2',
            'original catalogue or source rights mismatch')
    resources = catalogue.get('resources')
    require(isinstance(resources, list) and 0 < len(resources) <= 8192, 'resource inventory limit')
    expected = {packet_url(domain, run_utc, offset): offset for offset in range(HOURS)}
    rows = {}
    for resource in resources:
        require(isinstance(resource, dict), 'invalid catalogue resource')
        url = resource.get('url')
        title = resource.get('title')
        # Every advertised SP1 member of this exact cycle must agree with its
        # canonical URL. Poisoned/duplicated/partial cohorts cannot be hidden
        # by silently dropping an unrecognised entry.
        belongs = isinstance(title, str) and title.startswith(f'arome-om-{domain}__0025__SP1__') and run_utc in title
        if not belongs and url not in expected:
            continue
        require(url in expected and title == url.rsplit('/', 1)[1], 'source packet URL/title mismatch')
        offset = expected[url]
        require(offset not in rows and resource.get('format') == 'grib2', 'duplicated or wrong-format packet')
        size = resource.get('filesize')
        require(type(size) is int and 16 <= size <= MAX_PACKET_BYTES, 'source packet declared size limit')
        rows[offset] = {'offsetHours': offset, 'url': url, 'bytes': size}
    require(set(rows) == set(range(HOURS)), 'original SP1 cohort is incomplete')
    packets = [rows[offset] for offset in range(HOURS)]
    total = sum(row['bytes'] for row in packets)
    require(total <= MAX_COHORT_BYTES, 'regional cohort declared bytes exceed cap')
    constants = [resource for resource in resources if resource.get('title') == f"Champs CONSTANT {spec['grid']}0025"]
    require(len(constants) == 1 and constants[0].get('format') == 'grib2', 'original constant grid is missing/ambiguous')
    reference = constants[0].get('url')
    require(isinstance(reference, str) and re.fullmatch(
        r'https://www\.data\.gouv\.fr/fr/datasets/r/[a-f0-9-]{36}', reference),
        'constant reference must be an original catalogue resource')
    return {
        'schema': 1, 'model': spec['model'], 'domain': domain, 'grid': spec['grid'],
        'runUtc': run_utc, 'catalogueSha256': digest(raw),
        'licence': 'Etalab-2.0', 'attribution': 'Météo-France AROME-OM',
        'resolutionDegrees': 0.025, 'bounds': spec['bounds'],
        'width': spec['width'], 'height': spec['height'], 'packets': packets,
        'declaredForecastBytes': total, 'constantResource': reference,
        'limits': {'objectBytes': MAX_PACKET_BYTES, 'cohortBytes': MAX_COHORT_BYTES,
                   'dayBytes': MAX_DAY_BYTES, 'readsPerCohort': HOURS,
                   'secondsPerRead': 20, 'secondsPerCohort': 1200,
                   'nativeMemoryBytes': 2 * 1024**3},
        'nativeMaskAndOriginalGridAdmissionRequired': True,
        'installed': False, 'published': False, 'liveCoverageClaim': False,
    }
