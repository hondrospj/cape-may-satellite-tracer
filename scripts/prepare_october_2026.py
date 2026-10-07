"""Crop authenticated Copernicus SAFE downloads on their original 10 m grid.
Run with a GDAL-enabled Python; no resampling or color changes are applied.
"""
from pathlib import Path
import hashlib, json, math, zipfile, xml.etree.ElementTree as ET
from datetime import datetime, timezone
import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ROOT = Path(__file__).resolve().parents[1]
STAC = ROOT / 'work/october-6-cdse-stac.json'
OUT = ROOT / 'public/data'
BOUNDS = [-75.1, 38.85, -74.5, 39.34]

def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def prepare(feature):
    scene_id = feature['id']
    zip_path = Path.home() / 'Downloads' / (scene_id + '.SAFE.zip')
    if not zip_path.is_file():
        raise FileNotFoundError(zip_path)
    tile = feature['properties']['grid:code'].split('-')[-1]
    scratch = ROOT / 'work/native' / tile
    scratch.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        tci_name = next(n for n in archive.namelist() if n.endswith('_TCI_10m.jp2'))
        metadata_name = next(n for n in archive.namelist() if n.endswith('/MTD_TL.xml'))
        product_name = next(n for n in archive.namelist() if n.endswith('/MTD_MSIL2A.xml'))
        native = scratch / Path(tci_name).name
        if not native.exists():
            native.write_bytes(archive.read(tci_name))
        xml = archive.read(metadata_name)
        (OUT / f'2026-10-06-{tile}-tile.xml').write_bytes(xml)
        (OUT / f'2026-10-06-{tile}-product.xml').write_bytes(archive.read(product_name))
    expected = feature['assets']['TCI_10m']['file:checksum']
    # Multihash code 0x16 is SHA3-256; 0x20 is its 32-byte digest length.
    assert expected.startswith('1620')
    with native.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha3_256').hexdigest() == expected[4:], 'Source checksum mismatch'
    root = ET.fromstring(xml)
    sensing = next(e.text for e in root.iter() if e.tag.split('}')[-1] == 'SENSING_TIME')
    cloud = float(next(e.text for e in root.iter() if e.tag.split('}')[-1] == 'CLOUDY_PIXEL_PERCENTAGE'))
    assert sensing.startswith('2026-10-06T')
    source = gdal.Open(str(native))
    gt = source.GetGeoTransform()
    assert source.RasterCount == 3 and gt[1] == 10 and gt[5] == -10
    assert source.GetSpatialRef().GetAuthorityCode(None) == '32618'
    geo = osr.SpatialReference(); geo.ImportFromEPSG(4326); geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    utm = source.GetSpatialRef(); utm.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    to_utm = osr.CoordinateTransformation(geo, utm)
    to_geo = osr.CoordinateTransformation(utm, geo)
    west,south,east,north = BOUNDS
    points = [to_utm.TransformPoint(x,y) for x in np.linspace(west,east,30) for y in [south,north]] + [to_utm.TransformPoint(x,y) for x in [west,east] for y in np.linspace(south,north,30)]
    x0=max(0,math.floor((min(p[0] for p in points)-gt[0])/10))
    x1=min(source.RasterXSize,math.ceil((max(p[0] for p in points)-gt[0])/10))
    y0=max(0,math.floor((gt[3]-max(p[1] for p in points))/10))
    y1=min(source.RasterYSize,math.ceil((gt[3]-min(p[1] for p in points))/10))
    cropped = gdal.Translate('', source, format='MEM', srcWin=[x0,y0,x1-x0,y1-y0])
    destination = OUT / f'2026-10-06-{tile}-10m.tif'
    gdal.Translate(str(destination), cropped, format='COG', creationOptions=['COMPRESS=DEFLATE','LEVEL=9','BLOCKSIZE=256','RESAMPLING=NEAREST'])
    result = gdal.Open(str(destination))
    assert result.GetGeoTransform() == cropped.GetGeoTransform()
    assert np.array_equal(result.ReadAsArray(), source.ReadAsArray(x0,y0,x1-x0,y1-y0))
    assert destination.stat().st_size < 100*1024*1024
    left,top=gt[0]+x0*10,gt[3]-y0*10
    right,bottom=gt[0]+x1*10,gt[3]-y1*10
    ring=ogr.Geometry(ogr.wkbLinearRing)
    for x,y in [(left,top),(right,top),(right,bottom),(left,bottom),(left,top)]:
        lon,lat,_=to_geo.TransformPoint(x,y); ring.AddPoint_2D(lon,lat)
    polygon=ogr.Geometry(ogr.wkbPolygon); polygon.AddGeometry(ring)
    # Restrict the advertised footprint to pixels present in the source scene.
    footprint=polygon.Intersection(ogr.CreateGeometryFromJson(json.dumps(feature['geometry'])))
    bbox=footprint.GetEnvelope()
    provenance = {'source_asset':feature['assets']['TCI_10m']['href'],'source_asset_sha256':digest(native),'source_catalog_multihash':feature['assets']['TCI_10m'].get('file:checksum'),'source_archive':zip_path.name,'granule_sensing_time':sensing,'source_window_pixels':[x0,y0,x1-x0,y1-y0],'projection':'EPSG:32618','geotransform':list(result.GetGeoTransform()),'shape':[result.RasterYSize,result.RasterXSize],'processing':'Native 10 m pixel-aligned crop; identical RGB values verified against original JP2; lossless DEFLATE COG; nearest-neighbor overviews. No base-image resampling or color adjustment.','sha256':digest(destination),'bytes':destination.stat().st_size}
    (OUT / f'2026-10-06-{tile}-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    return {'id':scene_id,'datetime':sensing,'cloud_cover_percent':cloud,'bbox':[bbox[0],bbox[2],bbox[1],bbox[3]],'geometry':json.loads(footprint.ExportToJson()),'visual':f'./data/{destination.name}','asset_label':'Native 10 m county crop · GeoTIFF','stac':next(l['href'] for l in feature['links'] if l['rel']=='self'),'gsd_m':10,'sha256':provenance['sha256'],'provenance':f'./data/2026-10-06-{tile}-provenance.json'}

if __name__ == '__main__':
    import sys
    collection=json.loads(STAC.read_text())
    features=collection['features']
    if len(sys.argv)>1:
        features=[f for f in features if sys.argv[1] in f['id']]
    for feature in features:
        scene=prepare(feature)
        (ROOT/'work'/f"{feature['properties']['grid:code']}-scene.json").write_text(json.dumps(scene,indent=2)+'\n')
        print(scene['id'],scene['datetime'],scene['sha256'], flush=True)
    if len(features)==2:
        catalog=json.loads((OUT/'scenes.json').read_text())
        if catalog['dates'][1]['date']=='2026-02-28':
            (OUT/'archived-2026-02-28-scenes.json').write_text(json.dumps(catalog['dates'][1],indent=2)+'\n')
        catalog['source']='Copernicus Sentinel-2 L2A'
        catalog['retrieved_at']=datetime.now(timezone.utc).isoformat()
        catalog['dates'][0]['provider']='Earth Search'
        catalog['dates'][0]['source']='Copernicus Sentinel-2 L2A / Element 84 Earth Search'
        catalog['dates'][1]={'date':'2026-10-06','provider':'Copernicus Data Space','source':'Copernicus Sentinel-2 L2A / Copernicus Data Space','scenes':[json.loads((ROOT/'work'/f"{f['properties']['grid:code']}-scene.json").read_text()) for f in sorted(features,key=lambda f:f['id'])]}
        (OUT/'scenes.json').write_text(json.dumps(catalog,indent=2)+'\n')
        (OUT/'2026-10-06-stac.json').write_text(STAC.read_text())
