import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fromArrayBuffer} from 'geotiff';
import {worldfile,toKML,toCSV,validateImport,DATES,encodeGeoTIFF} from '../src/exports.js';

const sample={type:'FeatureCollection',features:[{type:'Feature',id:'test-line',properties:{name:'Beach & <dune>',image_date:'2025-10-16',length_m:123.45,source:'Sentinel-2',scene_ids:['scene1'],capture_times_utc:['2025-10-16T16:02:19Z']},geometry:{type:'LineString',coordinates:[[-74.76,39.04],[-74.77,39.05]]}}]};
test('worldfile uses upper-left pixel center and negative north-up Y resolution',()=>{
  const numbers=worldfile([100,200,500,600],40,20).trim().split('\n').map(Number);
  assert.deepEqual(numbers,[10,0,0,-20,105,590]);
  assert.equal(numbers[4]+39*numbers[0],495);assert.equal(numbers[5]+19*numbers[3],210);
});
test('KML preserves coordinate order and escapes names and metadata',()=>{
  const kml=toKML(sample);assert.match(kml,/Beach &amp; &lt;dune&gt;/);assert.match(kml,/-74.76,39.04,0 -74.77,39.05,0/);assert.match(kml,/<Data name="image_date"><value>2025-10-16/);
});
test('CSV includes every vertex, date and source; guards spreadsheet formulas',()=>{
  const copy=structuredClone(sample);copy.features[0].properties.name='=SUM(1,2)';const csv=toCSV(copy);
  assert.equal(csv.trim().split('\r\n').length,3);assert.match(csv,/"'=SUM\(1,2\)"/);assert.match(csv,/"-74.76","39.04"/);assert.match(csv,/2025-10-16T16:02:19Z/);
});
test('GeoJSON validates geographic coordinates and compatible dates',()=>{
  assert.equal(validateImport(sample),sample);
  for(const bad of [{type:'FeatureCollection',features:[{...sample.features[0],geometry:{type:'Point',coordinates:[-74,39]}}]}, {type:'FeatureCollection',features:[{...sample.features[0],geometry:{type:'LineString',coordinates:[[-8300000,4800000],[-8301000,4801000]]}}]}, {type:'FeatureCollection',features:[{...sample.features[0],properties:{image_date:'2026-10-05'}}]}])assert.throws(()=>validateImport(bad));
});
test('RGB alpha GeoTIFF georeferencing survives a write/read roundtrip',async()=>{
  const pixels=new Uint8ClampedArray([5,20,100,255,20,30,200,255,4,8,16,255,0,0,0,0]);
  const buffer=encodeGeoTIFF({width:2,height:2,data:pixels},[-8340000,4719980,-8339980,4720000],{image_date:DATES[0],source_urls:Array(4).fill('https://example.com/'+ 'a'.repeat(300))});
  const tiff=await fromArrayBuffer(buffer),image=await tiff.getImage();assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey,3857);assert.deepEqual(image.getBoundingBox(),[-8340000,4719980,-8339980,4720000]);assert.deepEqual(Array.from(await image.readRasters({interleave:true})),Array.from(pixels));assert.match(image.getFileDirectory().getValue('ImageDescription'),/2025-10-16/);
});
test('all four published source scenes were acquired on the exact selected days',()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/scenes.json',import.meta.url)));
  assert.deepEqual(catalog.dates.map(d=>d.date),DATES);
  for(const d of catalog.dates){assert.equal(d.scenes.length,2);for(const s of d.scenes){assert.ok(s.datetime.startsWith(d.date+'T'));assert.ok(s.visual.startsWith('https://sentinel-cogs.s3.us-west-2.amazonaws.com/')||s.visual.startsWith('./data/2026-10-06-'));assert.equal(s.gsd_m,10);assert.equal(s.geometry.type,'Polygon');assert.ok(s.stac.startsWith('https://'));}}
});

test('archived February traces retain their original date and source',()=>{
  const saved=structuredClone(sample);saved.features[0].properties.image_date='2026-02-28';
  assert.equal(validateImport(saved),saved);
  assert.equal(saved.features[0].properties.image_date,'2026-02-28');
  assert.match(toCSV(saved),/2026-02-28/);
});
test('October 2026 assets match hashes and preserve 10 m native georeferencing',async()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/scenes.json',import.meta.url)));
  for(const scene of catalog.dates[1].scenes){
    const bytes=fs.readFileSync(new URL('../public/'+scene.visual.slice(2),import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),scene.sha256);
    const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    const img=await tiff.getImage();assert.equal(img.getGeoKeys().ProjectedCSTypeGeoKey,32618);
    assert.deepEqual(img.getResolution(),[10,-10,0]);assert.equal(img.getSamplesPerPixel(),3);
    const provenance=JSON.parse(fs.readFileSync(new URL('../public/'+scene.provenance.slice(2),import.meta.url)));
    assert.equal(provenance.granule_sensing_time,scene.datetime);assert.equal(provenance.sha256,scene.sha256);
    const exported=encodeGeoTIFF({width:1,height:1,data:new Uint8ClampedArray([10,20,30,255])},[0,0,10,10],{image_date:DATES[1],scene_ids:catalog.dates[1].scenes.map(s=>s.id),source:catalog.dates[1].source,exported_at:new Date().toISOString()});
    const copy=await(await fromArrayBuffer(exported)).getImage();assert.match(copy.getFileDirectory().getValue('ImageDescription'),/2026-10-06/);
  }
});
