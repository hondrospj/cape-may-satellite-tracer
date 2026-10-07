import {writeArrayBuffer} from 'geotiff';
export const DATES = ['2025-10-16', '2026-10-06'];
// Preserve traces made against the previously available February image.
export const TRACE_DATES = [...DATES, '2026-02-28'];
export const WKT_3857 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]';

export function worldfile(extent, width, height) {
  const x = (extent[2] - extent[0]) / width;
  const y = (extent[3] - extent[1]) / height;
  // Worldfiles locate the center of the first pixel, not its outer corner.
  return [x, 0, 0, -y, extent[0] + x / 2, extent[3] - y / 2].map(n => n.toFixed(10)).join('\n') + '\n';
}

export function encodeGeoTIFF(imageData,extent,manifest) {
  const {width,height,data}=imageData;
  // Canvas produces Uint8ClampedArray; geotiff.js requires a supported sample type.
  const pixels=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  // This writer reserves a 1,000-byte TIFF header. Keep descriptive metadata compact;
  // full URLs and footprint metadata remain in the source catalog / worldfile ZIP.
  const description=JSON.stringify({image_date:manifest.image_date,scene_ids:manifest.scene_ids,source:manifest.source||'Copernicus Sentinel-2 L2A',source_pixel_m:10,resampled:true,exported_at:manifest.exported_at});
  if(new TextEncoder().encode(description).length>480)throw new Error('GeoTIFF description is too large. Use the PNG/worldfile ZIP for full metadata.');
  return writeArrayBuffer(pixels,{width,height,SamplesPerPixel:[4],BitsPerSample:[8,8,8,8],SampleFormat:[1,1,1,1],PhotometricInterpretation:2,ExtraSamples:[2],ModelPixelScale:[(extent[2]-extent[0])/width,(extent[3]-extent[1])/height,0],ModelTiepoint:[0,0,0,extent[0],extent[3],0],GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1,ProjectedCSTypeGeoKey:3857,ImageDescription:description});
}

function xml(value) { return String(value ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function csv(value) { const s = String(value ?? ''); return '"' + s.replace(/"/g, '""') + '"'; }
export function toKML(collection) {
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cape May County shoreline traces</name>${collection.features.map(f => {
    const p = f.properties;
    return `<Placemark><name>${xml(p.name)}</name><Style><LineStyle><color>${p.image_date === DATES[0] ? 'ff51b7e9' : 'ffd6df61'}</color><width>3</width></LineStyle></Style><ExtendedData>${Object.entries(p).map(([k,v]) => `<Data name="${xml(k)}"><value>${xml(typeof v === 'object' ? JSON.stringify(v) : v)}</value></Data>`).join('')}</ExtendedData><LineString><tessellate>1</tessellate><coordinates>${f.geometry.coordinates.map(c => `${c[0]},${c[1]},0`).join(' ')}</coordinates></LineString></Placemark>`;
  }).join('')}</Document></kml>`;
}
export function toCSV(collection) {
  const rows = [['line_id','line_name','image_date','vertex','longitude','latitude','length_m','source','scene_ids','capture_times_utc']];
  for (const f of collection.features) for (let i=0;i<f.geometry.coordinates.length;i++) {
    const p=f.properties,c=f.geometry.coordinates[i];
    // Neutralize spreadsheet formulas in user-editable text fields.
    const safeName = /^[=+\-@\t\r]/.test(p.name ?? '') ? "'"+p.name : p.name;
    rows.push([f.id,safeName,p.image_date,i+1,c[0],c[1],p.length_m,p.source,(p.scene_ids||[]).join(';'),(p.capture_times_utc||[]).join(';')]);
  }
  return rows.map(row=>row.map(csv).join(',')).join('\r\n')+'\r\n';
}
export function validateImport(data) {
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Choose a GeoJSON FeatureCollection of lines.');
  if (data.features.length > 500) throw new Error('Import at most 500 lines at a time.');
  let vertices=0;
  for (const f of data.features) {
    if(f.type !== 'Feature' || f.geometry?.type !== 'LineString' || !Array.isArray(f.geometry.coordinates) || f.geometry.coordinates.length < 2) throw new Error('Each feature must be a LineString with at least two points.');
    vertices+=f.geometry.coordinates.length;
    for (const c of f.geometry.coordinates) if(!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[0])>180 || Math.abs(c[1])>85.05) throw new Error('Coordinates must be WGS 84 longitude/latitude, within the map projection.');
    if(f.properties?.image_date && !TRACE_DATES.includes(f.properties.image_date)) throw new Error('Image dates must be October 16, 2025, October 6, 2026, or the archived February 28, 2026 image.');
  }
  if(vertices > 100000) throw new Error('The file has too many vertices (maximum 100,000).');
  return data;
}
