import {zipSync, strToU8} from 'fflate';
import {validateImport} from './exports.js';

const WGS84='GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';
const encoder=new TextEncoder();

export function selectExportLines(collection,scope,selectedId) {
  if(scope==='all')return collection;
  const feature=collection.features.find(f=>f.id===selectedId);
  if(!feature)throw new Error('Select a saved line first.');
  return {...collection,features:[feature]};
}

function bounds(points) {
  return points.reduce((b,[x,y])=>[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)],[Infinity,Infinity,-Infinity,-Infinity]);
}
function putBounds(view,offset,bbox) {bbox.forEach((n,i)=>view.setFloat64(offset+i*8,n,true));}
function header(view,bbox) {
  // ESRI: file lengths/offsets are big-endian 16-bit words; geometry is little-endian.
  view.setInt32(0,9994);view.setInt32(24,view.byteLength/2);
  view.setInt32(28,1000,true);view.setInt32(32,3,true);putBounds(view,36,bbox);
}

// dBASE character fields have a 254-byte ceiling. Never cut a UTF-8 code point.
function utf8Cell(value,width) {
  const bytes=[];
  for(const character of String(value??'')) {
    const encoded=encoder.encode(character==='\0'?' ':character);
    if(bytes.length+encoded.length>width)break;
    bytes.push(...encoded);
  }
  return new Uint8Array(bytes);
}
function attributes(features) {
  const fields=[
    ['line_id','C',80,0,f=>f.id],
    ['name','C',254,0,f=>f.properties.name],
    ['image_date','C',10,0,f=>f.properties.image_date],
    ['length_m','N',20,2,f=>f.properties.length_m],
    ['source','C',120,0,f=>f.properties.source],
    ['scene_ids','C',254,0,f=>(f.properties.scene_ids||[]).join(';')],
    ['capt_utc','C',100,0,f=>(f.properties.capture_times_utc||[]).join(';')],
    ['created','C',30,0,f=>f.properties.created_utc],
    ['updated','C',30,0,f=>f.properties.updated_utc],
  ];
  const headerSize=32+fields.length*32+1,recordSize=1+fields.reduce((n,f)=>n+f[2],0);
  const bytes=new Uint8Array(headerSize+recordSize*features.length+1),view=new DataView(bytes.buffer);
  const now=new Date();bytes.set([3,now.getUTCFullYear()-1900,now.getUTCMonth()+1,now.getUTCDate()]);
  view.setUint32(4,features.length,true);view.setUint16(8,headerSize,true);view.setUint16(10,recordSize,true);
  fields.forEach(([name,type,width,decimals],i)=>{
    const offset=32+i*32;bytes.set(encoder.encode(name),offset);bytes[offset+11]=type.charCodeAt(0);bytes[offset+16]=width;bytes[offset+17]=decimals;
  });
  bytes[headerSize-1]=13;
  features.forEach((f,i)=>{
    let offset=headerSize+i*recordSize;bytes.fill(32,offset,offset+recordSize);offset++;
    for(const [,type,width,decimals,get] of fields){
      const value=get(f);
      if(type==='N') {
        if(value!==undefined&&value!==null&&value!=='') {
          if(!Number.isFinite(Number(value)))throw new Error('A line has an invalid length.');
          const text=Number(value).toFixed(decimals);
          if(text.length>width)throw new Error('A line length is too large for a shapefile.');
          bytes.set(encoder.encode(text.padStart(width)),offset);
        }
      } else bytes.set(utf8Cell(value,width),offset);
      offset+=width;
    }
  });
  bytes[bytes.length-1]=26;
  return bytes;
}

export function toShapefileZip(collection) {
  validateImport(collection);
  const features=collection.features;
  if(!features.length)throw new Error('Select or draw a line first.');
  const lines=features.map(f=>f.geometry.coordinates);
  for(const line of lines)if(!line.some(([x,y])=>x!==line[0][0]||y!==line[0][1]))throw new Error('A shapefile line needs at least two different points.');
  const bbox=bounds(lines.flat()),sizes=lines.map(line=>48+16*line.length);
  const shp=new Uint8Array(100+sizes.reduce((n,size)=>n+8+size,0)),shx=new Uint8Array(100+8*lines.length);
  const shape=new DataView(shp.buffer),index=new DataView(shx.buffer);header(shape,bbox);header(index,bbox);
  let offset=100;
  lines.forEach((line,i)=>{
    index.setInt32(100+i*8,offset/2);index.setInt32(104+i*8,sizes[i]/2);
    shape.setInt32(offset,i+1);shape.setInt32(offset+4,sizes[i]/2);
    const start=offset+8;shape.setInt32(start,3,true);putBounds(shape,start+4,bounds(line));
    shape.setInt32(start+36,1,true);shape.setInt32(start+40,line.length,true);shape.setInt32(start+44,0,true);
    line.forEach(([x,y],j)=>{shape.setFloat64(start+48+j*16,x,true);shape.setFloat64(start+56+j*16,y,true);});
    offset+=8+sizes[i];
  });
  // The included GeoJSON retains full text/provenance beyond DBF field limits and can be re-imported.
  return zipSync({
    'traces.shp':shp,'traces.shx':shx,'traces.dbf':attributes(features),
    'traces.prj':strToU8(WGS84),'traces.cpg':strToU8('UTF-8'),
    'traces.geojson':strToU8(JSON.stringify(collection,null,2)),
    'README.txt':strToU8('Coastline Studio shoreline traces\n\nUnzip and open traces.shp in QGIS, ArcGIS or another GIS. Keep the SHP, SHX, DBF, PRJ and CPG files together. Coordinates are WGS 84 longitude/latitude (EPSG:4326).\n\nEach line has its original image date, name, length in meters, source and scene identifiers. DBF text fields have byte limits; traces.geojson preserves complete original properties and can be imported back into Coastline Studio.\n\nTraces are manual interpretations of satellite imagery, not surveyed or tide-normalized shorelines.\n'),
  });
}
