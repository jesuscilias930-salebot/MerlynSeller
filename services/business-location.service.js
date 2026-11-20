const { z } = require('zod');
const db = require('../lib/db');

// Coordenadas con 6 decimales (~10 cm): suficiente para un pin y evita ruido del GPS.
const coordinate = (min, max) => z.coerce.number().finite().min(min).max(max).transform((value) => Math.round(value * 1e6) / 1e6);
const optionalText = (max) => z.string().trim().max(max).optional().nullable().transform((value) => value || null);
const locationSchema = z.object({
  latitude: coordinate(-90, 90),
  longitude: coordinate(-180, 180),
  name: optionalText(160),
  address: optionalText(512),
});

const invalid = (issues) => {
  const field = issues[0]?.path?.[0];
  const error = new Error(field === 'latitude' || field === 'longitude'
    ? 'La ubicación no es válida: revisa la latitud (-90 a 90) y la longitud (-180 a 180).'
    : field === 'name' ? 'El nombre puede tener hasta 160 caracteres.' : 'La dirección puede tener hasta 512 caracteres.');
  error.status = 400;
  return error;
};

exports.parse = (input) => {
  const result = locationSchema.safeParse(input || {});
  if (!result.success) throw invalid(result.error.issues);
  return result.data;
};

exports.mapsUrl = ({ latitude, longitude }) => `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

/** Texto del mensaje: lo ve el cliente en Messenger/Instagram (no tienen pin) y es la vista previa en el chat. */
exports.messageBody = (location) => ['📍 ' + (location.name || 'Ubicación'), location.address, exports.mapsUrl(location)].filter(Boolean).join('\n');

const row = (value) => value ? { name: value.name, address: value.address, latitude: Number(value.latitude), longitude: Number(value.longitude), updatedAt: value.updated_at } : null;

exports.get = async (organizationId) => row((await db.query(
  'SELECT name, address, latitude, longitude, updated_at FROM business_locations WHERE organization_id=$1', [organizationId],
)).rows[0]);

exports.save = async (organizationId, input) => {
  const data = exports.parse(input);
  return row((await db.query(`
    INSERT INTO business_locations (organization_id, name, address, latitude, longitude) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (organization_id) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, updated_at=now()
    RETURNING name, address, latitude, longitude, updated_at`, [organizationId, data.name, data.address, data.latitude, data.longitude])).rows[0]);
};

exports.remove = async (organizationId) => { await db.query('DELETE FROM business_locations WHERE organization_id=$1', [organizationId]); };
