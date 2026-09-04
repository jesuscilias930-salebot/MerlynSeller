require('dotenv').config({ quiet: true });

const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not configured');

const target = new URL(databaseUrl);
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (!localHosts.has(target.hostname)) {
  throw new Error('This seed only runs against a local PostgreSQL database. Refusing to write to a remote database.');
}

const pool = new Pool({ connectionString: databaseUrl });

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const membership = await client.query(`
      SELECT organization_id
      FROM memberships
      ORDER BY organization_id
      LIMIT 1
    `);
    if (!membership.rows[0]) {
      throw new Error('No local organization exists yet. Start the app and log in once before running this seed.');
    }

    const organizationId = membership.rows[0].organization_id;
    const initialColumn = await client.query(`
      SELECT id FROM lead_columns
      WHERE organization_id = $1
      ORDER BY position ASC, created_at ASC
      LIMIT 1
    `, [organizationId]);
    const contact = await client.query(`
      INSERT INTO contacts (organization_id, phone_number, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, phone_number)
      DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      RETURNING id
    `, [organizationId, '5215550000000', 'Cliente de prueba']);
    const conversation = await client.query(`
      INSERT INTO conversations (organization_id, contact_id, lead_column_id, status)
      VALUES ($1, $2, $3, 'open')
      ON CONFLICT (organization_id, contact_id)
      DO UPDATE SET lead_column_id = COALESCE(conversations.lead_column_id, EXCLUDED.lead_column_id),
                    status = 'open', updated_at = now()
      RETURNING id
    `, [organizationId, contact.rows[0].id, initialColumn.rows[0]?.id || null]);
    const conversationId = conversation.rows[0].id;

    await client.query(`
      DELETE FROM messages
      WHERE conversation_id = $1
        AND provider_message_id IN ('mock_local_inbound_001', 'mock_local_outbound_001')
    `, [conversationId]);
    await client.query(`
      INSERT INTO messages (organization_id, conversation_id, direction, type, body, status, provider_message_id, created_at)
      VALUES
        ($1, $2, 'inbound', 'text', 'Hola, ¿me podrías compartir el catálogo y los precios por mayoreo?', 'received', 'mock_local_inbound_001', now() - interval '2 minutes'),
        ($1, $2, 'outbound', 'text', '¡Hola! Claro, con gusto te comparto la información. ¿Qué tipo de calcetas buscas?', 'delivered', 'mock_local_outbound_001', now() - interval '1 minute')
    `, [organizationId, conversationId]);
    await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ message: 'Local mock conversation created', conversationId }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
