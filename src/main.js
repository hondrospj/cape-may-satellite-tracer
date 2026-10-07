import './style.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Collection from 'ol/Collection.js';
import Point from 'ol/geom/Point.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WebGLTile from 'ol/layer/WebGLTile.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GeoTIFF from 'ol/source/GeoTIFF.js';
import Draw from 'ol/interaction/Draw.js';
import Modify from 'ol/interaction/Modify.js';
import {defaults as defaultControls, ScaleLine} from 'ol/control.js';
import {Style, Stroke, Fill, Text, Circle as CircleStyle} from 'ol/style.js';
import {fromLonLat, toLonLat, transformExtent, getPointResolution} from 'ol/proj.js';
import {register} from 'ol/proj/proj4.js';
import {getLength} from 'ol/sphere.js';
import {unByKey} from 'ol/Observable.js';
import proj4 from 'proj4';
import {zipSync, strToU8} from 'fflate';
import {DATES, WKT_3857, worldfile, toKML, toCSV, validateImport, encodeGeoTIFF} from './exports.js';

const $=id=>document.getElementById(id);
const COLOR={[DATES[0]]:'#e9b751',[DATES[1]]:'#61dfd6'};
const DATE_LABEL={[DATES[0]]:'October 16, 2025',[DATES[1]]:'February 28, 2026'};
const STORE='coastline-studio-cape-may-v1';
const countyExtent=transformExtent([-75.08,38.90,-74.53,39.32],'EPSG:4326','EPSG:3857');
const places={
  'cape-may':[-74.927,38.933,14],wildwood:[-74.820,38.985,14],
  'north-wildwood':[-74.794,39.006,15.5],
  'stone-harbor':[-74.766,39.047,14],avalon:[-74.725,39.091,14],
  'sea-isle':[-74.679,39.152,14],'ocean-city':[-74.584,39.271,13.5],
  'delaware-bay':[-74.990,39.105,12]
};
const geojson=new GeoJSON();
const vectorSource=new VectorSource();
const selectedFeatures=new Collection();
const view=new View({center:fromLonLat([-74.80,39.095]),zoom:10.5,minZoom:8,maxZoom:18,enableRotation:false});
const maps={};
let catalog,activeDate=DATES[1],comparing=false,mode='pan',selected=null,currentSketch=null,sketchKey=null,toastTimer,exporting=false;
let restoring=false;

proj4.defs('EPSG:32618','+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');
register(proj4);

function toast(message,ms=5500) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,ms);
}
function lengthText(m){return m>=1000?`${(m/1000).toFixed(2)} km`:`${Math.round(m)} m`;}
function lineStyle(feature) {
  if (!$('show-both').checked && feature.get('image_date')!==this.get('image_date')) return null;
  const isSelected=feature===selected;
  const styles=[new Style({stroke:new Stroke({color:'#132d35c9',width:isSelected?6:5})}),new Style({stroke:new Stroke({color:COLOR[feature.get('image_date')]||'#fff',width:isSelected?3.5:2.5})})];
  if(isSelected) styles.push(new Style({geometry:new MultiPoint(feature.getGeometry().getCoordinates()),image:new CircleStyle({radius:4,fill:new Fill({color:'#fff'}),stroke:new Stroke({color:'#1c625f',width:1.5})})}));
  return styles;
}
function redraw(){Object.values(maps).forEach(m=>m.vectors.changed());}
function metadata(date) {
  const d=catalog.dates.find(d=>d.date===date);
  return {image_date:date,source:'Copernicus Sentinel-2 L2A / Element 84 Earth Search',imagery_resolution_m:10,scene_ids:d.scenes.map(s=>s.id),capture_times_utc:d.scenes.map(s=>s.datetime),source_urls:d.scenes.map(s=>s.visual),interpretation:'Manually traced visible feature; not surveyed or tide-normalized'};
}
function featureCollection() {
  for (const f of vectorSource.getFeatures()) f.set('length_m',Math.round(getLength(f.getGeometry())*100)/100,true);
  const fc=geojson.writeFeaturesObject(vectorSource.getFeatures(),{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857',decimals:8});
  fc.name='Cape May County shoreline traces';fc.exported_at=new Date().toISOString();
  return fc;
}
function save() {
  if(restoring)return;
  try {localStorage.setItem(STORE,JSON.stringify(featureCollection()));$('save-status').textContent='✓ Saved in this browser';}
  catch {$('save-status').textContent='Local save unavailable — export your lines';toast('Your browser could not save these lines. Export GeoJSON to keep a copy.');}
}
function selectFeature(f) {
  selected=f;selectedFeatures.clear();if(f)selectedFeatures.push(f);
  $('selection-tools').hidden=!f;
  if(f)$('trace-name').value=f.get('name')||'Untitled line';
  renderTraces();redraw();
}
function renderTraces() {
  const features=vectorSource.getFeatures();$('trace-count').textContent=features.length;
  $('export-lines').disabled=!features.length||exporting;
  if(!features.length) {
    $('trace-list').innerHTML='<div class="empty-state"><svg viewBox="0 0 100 40" aria-hidden="true"><path d="m2 33 18-9 13 4 17-19 21 11 26-14"/><circle cx="2" cy="33" r="3"/><circle cx="50" cy="9" r="3"/><circle cx="97" cy="6" r="3"/></svg><p>Your shoreline starts here.</p><small>Draw a line to save it to this browser.</small></div>';
  } else {
    $('trace-list').replaceChildren();
    for(const f of features) {
      const button=document.createElement('button');button.className='trace-item'+(f===selected?' selected':'');button.setAttribute('aria-pressed',String(f===selected));
      const swatch=document.createElement('span');swatch.className='line-swatch';swatch.style.borderColor=COLOR[f.get('image_date')];
      const body=document.createElement('span'),name=document.createElement('b'),sub=document.createElement('small');
      name.textContent=f.get('name');sub.textContent=`${f.get('image_date')} · ${lengthText(getLength(f.getGeometry()))}`;body.append(name,sub);button.append(swatch,body);
      button.addEventListener('click',()=>{setMode('pan');setDate(f.get('image_date'));selectFeature(f);});$('trace-list').append(button);
    }
  }
}
function updateDrawActions() {
  const coords=currentSketch?.getGeometry().getCoordinates()||[];
  // OL repeats the pointer coordinate at the end of an unfinished line.
  const fixed=Math.max(0,coords.length-1);
  $('undo-vertex').disabled=fixed===0;$('finish').disabled=fixed<2;
  $('map-hint').textContent=mode==='edit'?'Drag a point to refine the line. Alt-click a point to remove it.':fixed?`${fixed} point${fixed===1?'':'s'} placed · double-click or Finish line`:'Click to start your line. Drag the map to pan.';
}
function setMode(next) {
  if(mode==='draw' && next!=='draw')Object.values(maps).forEach(m=>m.draw.abortDrawing());
  mode=next;
  for(const [date,m] of Object.entries(maps)) {
    m.draw.setActive(next==='draw'&&date===activeDate);m.modify.setActive(next==='edit'&&date===activeDate);
    m.element.classList.toggle('draw-mode',next==='draw'&&date===activeDate);
  }
  $('draw').hidden=next==='draw';$('draw-actions').hidden=next!=='draw';
  $('edit-line').setAttribute('aria-pressed',String(next==='edit'));$('edit-line').textContent=next==='edit'?'Done editing':'Edit points';
  $('map-hint').hidden=next==='pan';updateDrawActions();
}
function setDate(date) {
  if(exporting || !DATES.includes(date))return;
  if(date!==activeDate && mode!=='pan')setMode('pan');
  activeDate=date;
  document.querySelectorAll('.date-option').forEach(b=>{b.classList.toggle('active',b.dataset.date===date);b.setAttribute('aria-pressed',String(b.dataset.date===date));});
  document.querySelectorAll('.map-pane').forEach(p=>{p.hidden=!comparing&&p.dataset.pane!==date;p.classList.toggle('selected',p.dataset.pane===date);});
  document.querySelectorAll('.trace-date').forEach(b=>b.textContent=b.dataset.date===date?'Selected for tracing':'Trace this date');
  $('view-caption').textContent=comparing?'COMPARE · PAN & ZOOM TOGETHER':DATE_LABEL[date].toUpperCase();
  requestAnimationFrame(()=>Object.values(maps).forEach(m=>m.map.updateSize()));
  updateAvailability();redraw();
}
function updateAvailability() {
  const m=maps[activeDate];
  const ready=m?.ready&&!m?.failed;
  $('draw').disabled=!ready||exporting;$('export-image').disabled=!ready||exporting;
}
function fitCounty() {view.fit(countyExtent,{size:maps[activeDate].map.getSize(),padding:[35,35,35,35],duration:250});}
function inCoverage(date,coord) {return maps[date].footprints.some(f=>f.getGeometry().intersectsCoordinate(coord));}

function makeMap(date,index) {
  const data=catalog.dates.find(d=>d.date===date);
  const loading=document.querySelector(`[data-loading="${date}"]`);
  const footprints=data.scenes.map(s=>geojson.readFeature({type:'Feature',geometry:s.geometry,properties:{}},{featureProjection:'EPSG:3857'}));
  const rasters=data.scenes.map(s=>{
    const source=new GeoTIFF({sources:[{url:s.visual,nodata:0,min:0,max:255}],interpolate:false,convertToRGB:false,sourceOptions:{blockSize:65536,cacheSize:200}});
    source.setAttributions('Contains modified Copernicus Sentinel data · '+date.slice(0,4)+' · Earth Search');
    return new WebGLTile({source,preload:0,transition:0});
  });
  const vectors=new VectorLayer({source:vectorSource,image_date:date});vectors.setStyle(lineStyle.bind(vectors));
  const townFeatures=Object.entries(places).filter(([key])=>key!=='delaware-bay').map(([key,c])=>new Feature({geometry:new Point(fromLonLat(c)),name:document.querySelector(`#place option[value="${key}"]`).textContent}));
  const towns=new VectorLayer({source:new VectorSource({features:townFeatures}),declutter:true,style:f=>new Style({text:new Text({text:f.get('name'),font:'600 11px sans-serif',fill:new Fill({color:'#fff'}),stroke:new Stroke({color:'#163d3dc9',width:3}),offsetY:-10}),image:new CircleStyle({radius:2,fill:new Fill({color:'#ffffffcc'})})})});
  const element=$(index===0?'map-earlier':'map-later');
  const map=new Map({target:element,view,layers:[...rasters,towns,vectors],controls:defaultControls({rotate:false,attributionOptions:{collapsible:false}}).extend([new ScaleLine({units:'metric'})]),maxTilesLoading:12});
  const draw=new Draw({source:vectorSource,type:'LineString',stopClick:true,minPoints:2,condition:event=>{
    if(event.originalEvent.shiftKey || event.originalEvent.altKey)return false;
    if(!inCoverage(date,event.coordinate)){toast('That point is outside the dated imagery coverage.');return false;}return true;
  },style:new Style({stroke:new Stroke({color:COLOR[date],width:3}),image:new CircleStyle({radius:4,fill:new Fill({color:COLOR[date]}),stroke:new Stroke({color:'#fff',width:1.5})})})});
  const modify=new Modify({features:selectedFeatures});draw.setActive(false);modify.setActive(false);map.addInteraction(draw);map.addInteraction(modify);
  const m={date,map,element,rasters,vectors,towns,draw,modify,footprints,ready:false,failed:false,pending:0};maps[date]=m;
  rasters.forEach(layer=>{
    const source=layer.getSource();
    source.on('tileloadstart',()=>{m.pending++;loading.hidden=false;});
    source.on('tileloadend',()=>{m.pending=Math.max(0,m.pending-1);});
    source.on('tileloaderror',()=>{m.pending=Math.max(0,m.pending-1);m.failed=true;loading.classList.add('error');loading.textContent='Some imagery failed to load. Reload the page to retry.';loading.hidden=false;updateAvailability();});
    source.on('change',()=>{if(source.getState()==='error'){m.failed=true;loading.classList.add('error');loading.textContent='Unable to load this date’s imagery. Check your connection and reload.';loading.hidden=false;updateAvailability();}});
  });
  map.on('rendercomplete',()=>{if(!m.failed && m.rasters.every(l=>l.getSource().getState()==='ready')){m.ready=true;loading.hidden=true;element.dataset.imageryReady='true';}updateAvailability();});
  map.on('pointermove',event=>{const c=toLonLat(event.coordinate);$('coordinates').textContent=`${c[1].toFixed(5)}° N  ·  ${Math.abs(c[0]).toFixed(5)}° W`;});
  map.on('singleclick',event=>{if(mode!=='pan'||exporting)return;const f=map.forEachFeatureAtPixel(event.pixel,f=>f,{layerFilter:l=>l===vectors,hitTolerance:6});selectFeature(f||null);});
  draw.on('drawstart',event=>{currentSketch=event.feature;sketchKey=currentSketch.getGeometry().on('change',updateDrawActions);updateDrawActions();});
  draw.on('drawabort',()=>{if(sketchKey)unByKey(sketchKey);sketchKey=null;currentSketch=null;updateDrawActions();});
  draw.on('drawend',event=>{
    const feature=event.feature;feature.setId(crypto.randomUUID());feature.setProperties({...metadata(date),name:`Shoreline ${vectorSource.getFeatures().length+1}`,created_utc:new Date().toISOString(),updated_utc:new Date().toISOString()});
    if(sketchKey)unByKey(sketchKey);sketchKey=null;currentSketch=null;
    queueMicrotask(()=>{setMode('pan');selectFeature(feature);save();toast('Line saved. Select Edit points to refine it.');});
  });
  modify.on('modifyend',()=>{if(selected){selected.set('updated_utc',new Date().toISOString());save();renderTraces();}});
  return m;
}

function download(blob,name) {
  const a=$('download-file');if(a.href.startsWith('blob:'))URL.revokeObjectURL(a.href);
  a.href=URL.createObjectURL(blob);a.download=name;a.textContent=`${name} · ${(blob.size/1024).toFixed(0)} KB`;$('download-card').hidden=false;a.click();
}
function canvasBlob(canvas) {return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('The browser could not encode the image.')),'image/png'));}
function waitForRender(map) {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{unByKey(key);reject(new Error('Imagery is still loading. Try a smaller area or retry.'));},60000);const key=map.once('rendercomplete',()=>{clearTimeout(timer);resolve();});map.renderSync();});
}
async function exportImage() {
  if(exporting)return;
  const m=maps[activeDate],map=m.map,format=$('image-format').value;
  if(!m.ready||m.failed)return;
  setMode('pan');exporting=true;updateAvailability();renderTraces();
  const target=map.getTarget(),size=map.getSize().map(Math.round),extent=view.calculateExtent(size),date=activeDate;
  const canvas=document.createElement('canvas');canvas.width=size[0];canvas.height=size[1];
  const vectorVisible=m.vectors.getVisible(),townVisible=m.towns.getVisible();
  toast('Preparing your image…',65000);
  try {
    if(format!=='png'){m.vectors.setVisible(false);m.towns.setVisible(false);}
    map.setTarget(canvas);map.setSize(size);await waitForRender(map);
    if(m.failed)throw new Error('A source tile failed to load. Reload the imagery before exporting.');
    const base=`cape-may-${date}`,manifest={...metadata(date),exported_at:new Date().toISOString(),projection:'EPSG:3857',extent_m:extent,width:size[0],height:size[1],pixel_size_projection_m:[(extent[2]-extent[0])/size[0],(extent[3]-extent[1])/size[1]],resampled:true,source_pixel_size_m:10,rotation_degrees:0,includes_traces:format==='png',note:'Visible map extent resampled from source imagery; zoom does not improve the 10 m source resolution.'};
    if(format==='png') {
      const output=document.createElement('canvas');output.width=canvas.width;output.height=canvas.height+54;const ctx=output.getContext('2d');ctx.fillStyle='#153d3e';ctx.fillRect(0,0,output.width,output.height);ctx.drawImage(canvas,0,0);
      ctx.fillStyle='#effbf2';ctx.font='600 12px sans-serif';ctx.fillText(`Cape May County · ${DATE_LABEL[date]} · Sentinel-2 · 10 m source`,12,canvas.height+21);
      ctx.font='10px sans-serif';ctx.fillStyle='#b4d6cc';ctx.fillText(`Contains modified Copernicus Sentinel data (${date.slice(0,4)}) / Earth Search · Traces are not surveyed`,12,canvas.height+40);
      download(await canvasBlob(output),base+'-map.png');
    } else if(format==='geotiff') {
      const pixels=canvas.getContext('2d').getImageData(0,0,size[0],size[1]);
      const buffer=encodeGeoTIFF(pixels,extent,manifest);
      download(new Blob([buffer],{type:'image/tiff'}),base+'.tif');
    } else {
      const png=await canvasBlob(canvas);
      const zipped=zipSync({[base+'.png']:[new Uint8Array(await png.arrayBuffer()),{level:0}],[base+'.pgw']:strToU8(worldfile(extent,size[0],size[1])),[base+'.prj']:strToU8(WKT_3857),[base+'-metadata.json']:strToU8(JSON.stringify(manifest,null,2))});
      download(new Blob([zipped],{type:'application/zip'}),base+'-georeferenced.zip');
    }
    toast('Image exported.');
  } catch(error){console.error(error);toast(error.message,10000);}
  finally {map.setTarget(target);m.vectors.setVisible(vectorVisible);m.towns.setVisible(townVisible);map.updateSize();exporting=false;updateAvailability();renderTraces();}
}

function sceneInfo() {
  for(const d of catalog.dates) {
    const block=document.createElement('section');block.className='scene-block';const h=document.createElement('h3');h.textContent=DATE_LABEL[d.date];block.append(h);
    for(const scene of d.scenes){
      const p=document.createElement('p');p.textContent=`${scene.id} · ${scene.datetime.slice(11,19)} UTC · ${scene.cloud_cover_percent.toFixed(3)}% tile-wide cloud cover`;
      const links=document.createElement('div');links.className='scene-links';
      for(const [label,url] of [['Full-scene GeoTIFF',scene.visual],['Scene metadata',scene.stac]]){if(!url)continue;const a=document.createElement('a');a.textContent=label;a.href=url;a.target='_blank';a.rel='noopener';links.append(a);}
      block.append(p,links);
    }
    $('scene-details').append(block);
  }
}

function bindControls() {
  $('close-download').addEventListener('click',()=>{$('download-card').hidden=true;});
  document.querySelectorAll('[data-date]').forEach(b=>b.addEventListener('click',()=>setDate(b.dataset.date)));
  $('compare').addEventListener('click',()=>{if(exporting)return;comparing=!comparing;$('compare').setAttribute('aria-pressed',String(comparing));$('maps').classList.toggle('comparing',comparing);setDate(activeDate);});
  $('reset-view').addEventListener('click',fitCounty);
  $('place').addEventListener('change',()=>{const place=places[$('place').value];if(place)view.animate({center:fromLonLat(place),zoom:place[2],duration:400});else fitCounty();});
  $('draw').addEventListener('click',()=>{selectFeature(null);setMode('draw');$('sidebar').classList.remove('open');$('tools-toggle').setAttribute('aria-expanded','false');});
  $('cancel-draw').addEventListener('click',()=>setMode('pan'));
  $('undo-vertex').addEventListener('click',()=>{maps[activeDate].draw.removeLastPoint();updateDrawActions();});
  $('finish').addEventListener('click',()=>{if(!$('finish').disabled)maps[activeDate].draw.finishDrawing();});
  $('show-both').addEventListener('change',redraw);
  $('town-labels').addEventListener('change',()=>Object.values(maps).forEach(m=>m.towns.setVisible($('town-labels').checked)));
  $('trace-name').addEventListener('input',()=>{if(!selected)return;selected.set('name',$('trace-name').value.trim()||'Untitled line');selected.set('updated_utc',new Date().toISOString());save();renderTraces();});
  $('edit-line').addEventListener('click',()=>{if(!selected)return;if(selected.get('image_date')!==activeDate)setDate(selected.get('image_date'));setMode(mode==='edit'?'pan':'edit');});
  $('zoom-line').addEventListener('click',()=>{if(selected)view.fit(selected.getGeometry(),{size:maps[activeDate].map.getSize(),padding:[80,80,80,80],maxZoom:17,duration:250});});
  $('delete-line').addEventListener('click',()=>{if(!selected)return;const removed=selected;setMode('pan');selectFeature(null);vectorSource.removeFeature(removed);save();renderTraces();toast('Line deleted. Ctrl/Cmd+Z restores the last deleted line.');lastDeleted=removed;});
  $('import').addEventListener('click',()=>$('import-file').click());
  $('import-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{
      if(file.size>15*1024*1024)throw new Error('Choose a GeoJSON file smaller than 15 MB.');
      const data=validateImport(JSON.parse(await file.text()));
      const features=geojson.readFeatures(data,{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'});
      for(const f of features){
        const date=f.get('image_date')||activeDate,original={...f.getProperties()};delete original.geometry;
        if(!f.getId()||vectorSource.getFeatureById(f.getId()))f.setId(crypto.randomUUID());
        f.setProperties({...metadata(date),...original,image_date:date,name:String(original.name||'Imported line').slice(0,100),created_utc:original.created_utc||new Date().toISOString(),updated_utc:original.updated_utc||new Date().toISOString(),imported:true});
        if(!original.image_date)f.set('interpretation','Imported geometry; selected date is a reference image, not evidence of when this line was traced.');
      }
      vectorSource.addFeatures(features);save();renderTraces();if(features.length)selectFeature(features[0]);toast(`${features.length} line(s) imported. Lines without a date use the selected imagery date.`);
    }catch(error){toast('Import failed: '+error.message,9000);}finally{event.target.value='';}
  });
  $('export-lines').addEventListener('click',()=>{
    const fc=featureCollection();if(!fc.features.length)return;const format=$('line-format').value;
    const text=format==='geojson'?JSON.stringify(fc,null,2):format==='kml'?toKML(fc):toCSV(fc);
    const mime={geojson:'application/geo+json',kml:'application/vnd.google-earth.kml+xml',csv:'text/csv'}[format];download(new Blob([text],{type:mime}),'cape-may-shorelines.'+format);toast(`Exported ${fc.features.length} line(s) with dates and source metadata.`);
  });
  $('export-image').addEventListener('click',exportImage);
  $('about-button').addEventListener('click',()=>$('about').showModal());$('close-about').addEventListener('click',()=>$('about').close());
  $('about').addEventListener('click',e=>{if(e.target===$('about')&&e.offsetX>=0&&e.offsetY>=0){const r=$('about').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('about').close();}});
  $('tools-toggle').addEventListener('click',()=>{const open=$('sidebar').classList.toggle('open');$('tools-toggle').setAttribute('aria-expanded',String(open));});
  document.addEventListener('keydown',event=>{
    if(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||$('about').open||exporting)return;
    if(event.key==='Escape'){setMode('pan');selectFeature(null);}
    if(event.key.toLowerCase()==='d'&&!event.metaKey&&!event.ctrlKey&&!$('draw').disabled){selectFeature(null);setMode('draw');}
    if(event.key==='Enter'&&mode==='draw'&&!$('finish').disabled){event.preventDefault();maps[activeDate].draw.finishDrawing();}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();if(mode==='draw'){maps[activeDate].draw.removeLastPoint();updateDrawActions();}else if(lastDeleted){vectorSource.addFeature(lastDeleted);selectFeature(lastDeleted);lastDeleted=null;save();renderTraces();}}
  });
  view.on('change:resolution',()=>{const resolution=getPointResolution('EPSG:3857',view.getResolution(),view.getCenter());$('resolution-note').textContent=resolution<10?'Zoomed beyond native 10 m detail':'10 m source pixels · exact acquisition dates';});
}
let lastDeleted=null;

async function init() {
  try {
    const response=await fetch('./data/scenes.json');if(!response.ok)throw new Error('Unable to load the imagery catalog.');catalog=await response.json();
    for(const date of DATES){const d=catalog.dates.find(d=>d.date===date);if(!d?.scenes.length||d.scenes.some(s=>!s.datetime.startsWith(date)))throw new Error('Imagery catalog dates do not match the selected dates.');}
    DATES.forEach(makeMap);sceneInfo();bindControls();
    restoring=true;
    try{const saved=localStorage.getItem(STORE);if(saved){const fc=validateImport(JSON.parse(saved));vectorSource.addFeatures(geojson.readFeatures(fc,{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'}));}}
    catch{toast('Saved traces could not be read. Import an exported GeoJSON copy to restore them.');}
    restoring=false;renderTraces();setDate(activeDate);$('place').value='north-wildwood';requestAnimationFrame(()=>view.setCenter(fromLonLat(places['north-wildwood'])));view.setZoom(15.5);
  }catch(error){console.error(error);$('fatal-error').textContent=error.message+' Please reload to try again.';$('fatal-error').hidden=false;}
}
init();
