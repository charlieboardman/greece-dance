"""Run in the basemap builder image; no production services or network inputs."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m
terrain = module('terrain', ROOT / 'scripts/build-srtm-basemap.py')
build = module('basemap_build', ROOT / 'deploy/basemaps/build.py')

class ElevationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.args = argparse.Namespace(west=20, east=22, south=38, north=40, hgt_dir=self.root,
            min_zoom=8, max_zoom=8, quality=76, chunk_tiles=4, workers=1)
        self.reference = np.zeros((2401,2401), dtype=np.int16)
        for lat in [38,39]:
            for lon in [20,21]:
                y,x = np.indices((1201,1201))
                values = ((x + y*2 + (lat-38)*317 + (lon-20)*119) % 3000).astype('>i2')
                values[10,10] = -32768
                values.tofile(self.root / f'N{lat:02}E{lon:03}.hgt')
                row,col = (39-lat)*1200,(lon-20)*1200
                self.reference[row:row+1201,col:col+1201] = np.where(values == -32768,0,values)
        self.reader = terrain.ElevationTiles(self.args,max_open=2)
    def tearDown(self):
        self.reader.close(); self.tmp.cleanup()
    def test_rows_and_shared_granule_edges_match_original_mosaic(self):
        xs = np.array([0,1,10,1199,1200,1201,2399,2400])
        for y in [0,10,1199,1200,1201,2400]:
            np.testing.assert_array_equal(self.reader[y,xs],self.reference[y,xs])
        self.assertLessEqual(len(self.reader.open),2)
    def test_missing_granule_is_water_but_existing_shared_edges_survive(self):
        self.reader.close()
        (self.root/'N39E021.hgt').unlink()
        reader = terrain.ElevationTiles(self.args)
        try:
            self.assertEqual(reader[10,np.array([1210])][0],0)
            self.assertEqual(reader[1200,np.array([1210])][0],self.reference[1201,1210]-2)
        finally: reader.close()
    def test_sampling_and_chunk_halos_match_original(self):
        x0,y0,x1,y1 = terrain.tile_range(self.args,8)
        for y in range(y0,y1+1):
            a,b=terrain.sample_elevation(self.reference,self.args,8,x0,x1,y)
            c,d=terrain.sample_elevation(self.reader,self.args,8,x0,x1,y)
            np.testing.assert_array_equal(a,c);np.testing.assert_array_equal(b,d)
            wide=np.asarray(terrain.render_relief(a,b,8,y))
            for x in range(x0,x1+1):
                c,d=terrain.sample_elevation(self.reader,self.args,8,x,x,y)
                piece=np.asarray(terrain.render_relief(c,d,8,y))
                np.testing.assert_array_equal(piece,wide[:,(x-x0)*256:(x-x0+1)*256])
    def test_truncated_source_fails_before_render(self):
        (self.root/'N39E021.hgt').write_bytes(b'broken')
        with self.assertRaises(ValueError): terrain.ElevationTiles(self.args)
    def test_archive_validation_rejects_missing_tiles(self):
        from pmtiles.convert import mbtiles_to_pmtiles
        output=self.root/'sample.mbtiles'
        connection=terrain.initialize_database(output,self.args)
        # Build tiny true output, then package and validate its full tile count.
        self.args.min_zoom=0;self.args.max_zoom=0
        connection.close(); connection=terrain.initialize_database(output,self.args)
        terrain.render_pyramid(connection,self.reader,self.args,([],[],[]))
        connection.close()
        pm=self.root/'sample.pmtiles'
        mbtiles_to_pmtiles(str(output),str(pm),None)
        spec={'bounds':[20,38,22,40],'maxzoom':0}
        build.validate_archive(pm,spec)
        data=pm.read_bytes();pm.write_bytes(data[:127])
        with self.assertRaises(Exception):build.validate_archive(pm,spec)

class PipelineTests(unittest.TestCase):
    def test_fresh_interrupted_resumed_and_cached_builds(self):
        import shutil, zipfile, hashlib
        from unittest.mock import patch
        import shapefile
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';cache=root/'cache';versions=root/'versions'
            (source/'scripts').mkdir(parents=True)
            shutil.copy(ROOT/'scripts/build-srtm-basemap.py',source/'scripts/build-srtm-basemap.py')
            downloads=cache/'downloads';downloads.mkdir(parents=True)
            name='N38E020.SRTMGL3S.hgt.zip'
            with zipfile.ZipFile(downloads/name,'w',zipfile.ZIP_DEFLATED) as z:
                z.writestr('N38E020.hgt',np.full((1201,1201),400,dtype='>i2').tobytes())
            manifest=source/'sources.txt';manifest.write_text(build.digest(downloads/name)+'  '+name+'\n')
            hydro=[]
            for name,shape_type in [('ne_10m_coastline',3),('ne_10m_lakes',5),('ne_10m_rivers_lake_centerlines',3)]:
                target=root/name
                with shapefile.Writer(str(target),shapeType=shape_type) as w:
                    w.field('scalerank','N')
                    if shape_type==5:w.poly([[[10,10],[10,11],[11,11],[11,10],[10,10]]])
                    else:w.line([[[10,10],[11,11]]])
                    w.record(1)
                archive=downloads/(name+'.zip')
                with zipfile.ZipFile(archive,'w') as z:
                    for ext in ['shp','shx','dbf']:z.write(target.with_suffix('.'+ext),name+'.'+ext)
                hydro.append([name,build.digest(archive)])
            config=source/'terrain.json'
            config.write_text(json.dumps({'srtm_base':'https://invalid.example/', 'hydrography':hydro,
                'quality':76,'chunk_tiles':4,'outputs':[
                    {'file':'overview.pmtiles','bounds':[20,38,21,39],'maxzoom':0},
                    {'file':'greece-srtm-relief.pmtiles','bounds':[20,38,21,39],'maxzoom':1}]}))
            actual_run=build.subprocess.run
            calls=[]
            def interrupted(command,**kwargs):
                calls.append(command)
                if len(calls)==2:raise RuntimeError('Simulated interrupted render')
                return actual_run(command,**kwargs)
            with patch.object(build,'ROOT',source),patch.object(build,'CONFIG',config),patch.object(build,'MANIFEST',manifest),patch.object(build,'KEY_FILES',[config,manifest,source/'scripts/build-srtm-basemap.py']),patch.object(build.urllib.request,'urlopen',side_effect=AssertionError('No network in fixture')):
                version=build.key()
                with patch.object(build.subprocess,'run',side_effect=interrupted):
                    with self.assertRaisesRegex(RuntimeError,'interrupted'):build.build(cache,versions)
                self.assertFalse((versions/version).exists())
                self.assertTrue((versions/('.building-'+version)/'overview.pmtiles').exists())
                with patch.object(build.subprocess,'run',wraps=actual_run) as run:
                    self.assertEqual(build.build(cache,versions),version)
                    self.assertEqual(run.call_count,1,'Completed overview is reused after failure')
                self.assertTrue(build.verified(versions/version,version))
                with patch.object(build.subprocess,'run',side_effect=AssertionError('Must use completed asset cache')):
                    self.assertEqual(build.build(cache,versions),version)
                # Immutable published directories are never silently repaired/replaced.
                (versions/version/'overview.pmtiles').write_bytes(b'corrupt')
                self.assertFalse(build.verified(versions/version,version))

if __name__ == '__main__': unittest.main()
