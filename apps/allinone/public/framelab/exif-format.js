'use strict';

(() => {
// >>> PURE-HELPERS BEGIN
const EXIF_FIELDS = ['aperture', 'shutter', 'iso', 'focal'];

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatAperture(value) {
  const number = positiveNumber(value);
  if (!number) return '';
  // 超大光圈（f/1 以下）保留两位小数，避免 f/0.95 显示成 f/0.9。
  const text = number < 1 ? number.toFixed(2) : number.toFixed(1).replace(/\.0$/, '');
  return `f/${text}`;
}

function formatShutter(value) {
  const number = positiveNumber(value);
  if (!number) return '';
  if (number >= 1) return `${Math.round(number * 10) / 10}s`;
  // 慢于 1/2s 的快门用小数秒显示（如 0.8s），避免 1/Math.round(1/v) 舍入成错误的 1/1s。
  if (number > 0.5) return `${Math.round(number * 10) / 10}s`;
  return `1/${Math.round(1 / number)}s`;
}

function formatFocal(focal35, focal) {
  const number = positiveNumber(focal35) || positiveNumber(focal);
  return number ? `${Math.round(number)}mm` : '';
}

function buildExifFields(exif) {
  const data = exif || {};
  const iso = positiveNumber(data.ISO);
  return {
    aperture: formatAperture(data.FNumber),
    shutter: formatShutter(data.ExposureTime),
    iso: iso ? `ISO ${iso}` : '',
    focal: formatFocal(data.FocalLengthIn35mmFormat || data.FocalLengthIn35mmFilm, data.FocalLength),
  };
}

function buildExifCaption(fields, selected) {
  return EXIF_FIELDS.filter(key => selected.includes(key) && fields[key]).map(key => fields[key]).join(' ');
}
// >>> PURE-HELPERS END

window.FrameLabExifFormat = { EXIF_FIELDS, formatAperture, formatShutter, formatFocal, buildExifFields, buildExifCaption };
})();
