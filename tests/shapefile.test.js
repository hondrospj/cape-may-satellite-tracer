import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {toShapefileZip,selectExportLines} from '../src/shapefile.js';

export const fixture={type:'FeatureCollection',features:[
  {type:'Feature',id:'line-first',properties:{name:'Earlier shore',image_date:'2025-10-16',length_m:145.82,source:'Copernicus Sentinel-2 L2A',scene_ids:['earlier-scene'],capture_times_utc:['2025-10-16T16:02:15Z']},geometry:{type:'LineString',coordinates:[[-74.791,39.013],[-74.790,39.014]]}},
  {type:'Feature',id:'line-second',properties:{name:'October café 🌊',image_date:'2026-10-06',length_m:252.34,source:'Copernicus Sentinel-2 L2A / Copernicus Data Space',scene_ids:['S2C_MSIL2A_20261006T155131_N0513_R054_T18SWJ_20261006T185302'],source_urls:['https://example.test/full-metadata'],source_sha256:['test-sha256'],capture_times_utc:['2026-10-06T16:02:17.613299Z']},geometry:{type:'LineString',coordinates:[[-74.787,39.015],[-74.788,39.014],[-74.789,39.013]]}},
]};

test('selected-line export excludes every other line, including its backup metadata',()=>{
  const selected=selectExportLines(fixture,'selected','line-second');
  assert.equal(selected.features.length,1);assert.equal(fixture.features.length,2);
  const files=unzipSync(toShapefileZip(selected));
  assert.deepEqual(Object.keys(files).sort(),['README.txt','traces.cpg','traces.dbf','traces.geojson','traces.prj','traces.shp','traces.shx'].sort());
  const backup=JSON.parse(strFromU8(files['traces.geojson']));assert.deepEqual(backup,selected);
  assert.equal(strFromU8(files['traces.cpg']),'UTF-8');
  assert.match(strFromU8(files['traces.prj']),/GCS_WGS_1984/);
  assert.match(strFromU8(files['traces.dbf']),/October café 🌊/);
  assert.doesNotMatch(strFromU8(files['traces.dbf']),/Earlier shore/);
  assert.equal(new DataView(files['traces.dbf'].buffer).getUint32(4,true),1);
});
test('all-lines export keeps every line and missing selection fails instead of exporting all',()=>{
  assert.equal(selectExportLines(fixture,'all',null),fixture);
  assert.throws(()=>selectExportLines(fixture,'selected',null),/Select a saved line/);
  const files=unzipSync(toShapefileZip(fixture));
  assert.equal(new DataView(files['traces.dbf'].buffer).getUint32(4,true),2);
});
test('UTF-8 DBF fields stop at a complete character and full labels survive in GeoJSON',()=>{
  const copy=structuredClone(fixture);copy.features[0].properties.name='🌊'.repeat(100);
  const files=unzipSync(toShapefileZip(copy));
  assert.doesNotThrow(()=>new TextDecoder('utf-8',{fatal:true}).decode(files['traces.dbf'].subarray(new DataView(files['traces.dbf'].buffer).getUint16(8,true),-1)));
  assert.equal(JSON.parse(strFromU8(files['traces.geojson'])).features[0].properties.name,copy.features[0].properties.name);
});
test('invalid and zero-length geometry cannot create misleading shapefiles',()=>{
  const copy=structuredClone(fixture);copy.features[0].geometry.coordinates=[[-74.79,39.01],[-74.79,39.01]];
  assert.throws(()=>toShapefileZip(copy),/two different points/);
  assert.throws(()=>toShapefileZip({type:'FeatureCollection',features:[]}),/Select or draw/);
});
