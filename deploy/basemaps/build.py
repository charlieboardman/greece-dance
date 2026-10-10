#!/usr/bin/env python3
"""Content-addressed terrain builds; source and completed-output caches survive failure."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'assets/basemaps/srtm-relief/SRTMGL3S-SHA256SUMS'
CONFIG = Path(__file__).with_name('terrain.json')
KEY_FILES = [CONFIG, Path(__file__), Path(__file__).with_name('requirements.txt'),
             Path(__file__).with_name('Containerfile'), MANIFEST, ROOT / 'scripts/build-srtm-basemap.py']


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def key():
    h = hashlib.sha256()
    for path in KEY_FILES:
        h.update(str(path.relative_to(ROOT)).encode() + b'\0' + path.read_bytes() + b'\0')
    return h.hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.partial')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    os.replace(temporary, path)


def download(url, destination, expected):
    if destination.exists() and digest(destination) == expected:
        return
    partial = destination.with_suffix(destination.suffix + '.partial')
    for attempt in range(3):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {'User-Agent': 'NationalDanceMinistryMap-build/1.0 (https://github.com/charlieboardman/greece-dance)'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                append = offset and response.status == 206
                if append and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                    raise ValueError('Unexpected download range')
                with partial.open('ab' if append else 'wb') as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
            if digest(partial) != expected:
                partial.unlink()
                raise ValueError(f'Checksum mismatch: {destination.name}')
            os.replace(partial, destination)
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def extract(archive, directory):
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            name = Path(item.filename)
            if name.is_absolute() or '..' in name.parts or item.is_dir():
                raise ValueError(f'Unexpected archive entry: {item.filename}')
            # Source archives are flat. Do not accept paths or symlinks.
            if len(name.parts) != 1 or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f'Unsafe archive entry: {item.filename}')
            target = directory / name.name
            partial = target.with_suffix(target.suffix + '.partial')
            with z.open(item) as src, partial.open('wb') as out:
                shutil.copyfileobj(src, out)
            os.replace(partial, target)


def sources(cache, config):
    hgt = cache / 'hgt'
    hydro = cache / 'hydrography'
    downloads = cache / 'downloads'
    for directory in [hgt, hydro, downloads]:
        directory.mkdir(parents=True, exist_ok=True)
    lines = [line.split() for line in MANIFEST.read_text().splitlines() if line.strip()]
    receipts_path = cache / 'hgt-checksums.json'
    receipts = json.loads(receipts_path.read_text()) if receipts_path.exists() else {}
    pending = []
    for checksum, filename in lines:
        target = hgt / (filename.split('.')[0] + '.hgt')
        receipt = receipts.get(filename, {})
        if receipt.get('source') != checksum or not target.exists() or digest(target) != receipt.get('extracted'):
            pending.append((checksum, filename, target))
    # No raw+compressed duplicate cache and no giant mosaic. Keep room for the
    # current/previous artifacts, one output being packed, and the live app.
    needed = len(pending) * 1201 * 1201 * 2 + 2 * 1024 * 1024 * 1024
    if shutil.disk_usage(cache).free < needed:
        raise RuntimeError(f'Terrain build needs {needed / 1024**3:.1f} GiB free; release/cache files were not deleted.')
    for index, (checksum, filename, target) in enumerate(pending, 1):
        archive = downloads / filename
        print(f'SRTM {index}/{len(pending)}: {filename}', flush=True)
        download(config['srtm_base'] + filename, archive, checksum)
        extract(archive, hgt)
        if not target.exists() or target.stat().st_size != 1201 * 1201 * 2:
            raise ValueError(f'Invalid elevation granule: {filename}')
        receipts[filename] = {'source': checksum, 'extracted': digest(target)}
        atomic_json(receipts_path, receipts)
        archive.unlink()
    for name, checksum in config['hydrography']:
        archive = downloads / (name + '.zip')
        download(f'https://naturalearth.s3.amazonaws.com/10m_physical/{name}.zip', archive, checksum)
        extract(archive, hydro)
    return hgt, hydro


def verified(directory, version):
    try:
        value = json.loads((directory / 'manifest.json').read_text())
        config = json.loads(CONFIG.read_text())
        expected = {o['file'] for o in config['outputs']}
        return (value['version'] == version and set(value['files']) == expected
                and all(digest(directory / name) == sha for name, sha in value['files'].items()))
    except (OSError, KeyError, ValueError):
        return False


def validate_archive(path, output):
    from pmtiles.reader import Reader, MmapSource, all_tiles
    from pmtiles.tile import TileType
    from PIL import Image
    import io
    import math
    with path.open('rb') as stream:
        reader = Reader(MmapSource(stream))
        h = reader.header()
        assert h['tile_type'] == TileType.WEBP and h['max_zoom'] == output['maxzoom']
        assert [h[n] / 1e7 for n in ['min_lon_e7', 'min_lat_e7', 'max_lon_e7', 'max_lat_e7']] == output['bounds']
        # Read every indexed tile, validate images at every zoom, and reject a
        # truncated/incomplete archive before making it available to a release.
        count, zooms = 0, set()
        for (z, x, y), data in all_tiles(MmapSource(stream)):
            if z not in zooms:
                with Image.open(io.BytesIO(data)) as tile:
                    tile.load()
                    assert tile.size == (256, 256)
                zooms.add(z)
            count += 1
        west, south, east, north = output['bounds']
        def ty(lat, z):
            return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * (1 << z)
        expected = sum((math.ceil((east+180)/360*(1<<z))-math.floor((west+180)/360*(1<<z))) *
                       (math.ceil(ty(south,z))-math.floor(ty(north,z))) for z in range(output['maxzoom']+1))
        assert count == expected, (count, expected)
        assert zooms == set(range(output['maxzoom'] + 1))


def build(cache, versions):
    from pmtiles.convert import mbtiles_to_pmtiles
    version = key()
    destination = versions / version
    if verified(destination, version):
        print(f'Cached terrain: {version}', flush=True)
        return version
    if destination.exists():
        raise RuntimeError(f'Existing immutable artifact failed verification: {destination}. Restore it before deploying.')
    config = json.loads(CONFIG.read_text())
    cache.mkdir(parents=True, exist_ok=True)
    versions.mkdir(parents=True, exist_ok=True)
    hgt, hydro = sources(cache, config)
    work = cache / ('work-' + version)
    work.mkdir(exist_ok=True)
    stage = versions / ('.building-' + version)
    stage.mkdir(exist_ok=True)
    files = {}
    for output in config['outputs']:
        result = stage / output['file']
        receipt = result.with_suffix('.sha256')
        if result.exists() and receipt.exists() and digest(result) == receipt.read_text().strip():
            validate_archive(result, output)
            files[output['file']] = digest(result)
            continue
        mbtiles = work / (output['file'] + '.mbtiles')
        west, south, east, north = output['bounds']
        subprocess.run([sys.executable, str(ROOT / 'scripts/build-srtm-basemap.py'), str(hgt), str(hydro), str(mbtiles),
            '--west', str(west), '--south', str(south), '--east', str(east), '--north', str(north),
            '--max-zoom', str(output['maxzoom']), '--quality', str(config['quality']),
            '--chunk-tiles', str(config['chunk_tiles']), '--workers', '1'], check=True)
        partial = result.with_suffix('.partial')
        # The packer spools tile bytes to a TemporaryFile. Keep that on the
        # persistent working disk, not the builder's small /tmp tmpfs.
        old_tempdir = tempfile.tempdir
        try:
            tempfile.tempdir = str(work)
            mbtiles_to_pmtiles(str(mbtiles), str(partial), None)
        finally:
            tempfile.tempdir = old_tempdir
        validate_archive(partial, output)
        os.replace(partial, result)
        files[output['file']] = digest(result)
        receipt.write_text(files[output['file']] + '\n')
        mbtiles.unlink()
    for receipt in stage.glob('*.sha256'):
        receipt.unlink()
    atomic_json(stage / 'manifest.json', {'version': version, 'files': files, 'terrain': config})
    if destination.exists():
        # Never rewrite an immutable URL if the retained artifact is corrupted.
        raise RuntimeError(f'Existing artifact failed verification: {destination}. Restore it before deploying.')
    os.rename(stage, destination)
    shutil.rmtree(work)
    print(f'Terrain ready: {version}', flush=True)
    return version


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--key', action='store_true')
    parser.add_argument('--check', type=Path)
    parser.add_argument('--cache', type=Path, default=Path('/cache'))
    parser.add_argument('--versions', type=Path, default=Path('/versions'))
    args = parser.parse_args()
    if args.key:
        print(key())
    elif args.check:
        sys.exit(0 if verified(args.check / key(), key()) else 1)
    else:
        build(args.cache, args.versions)
