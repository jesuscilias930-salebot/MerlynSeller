const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const quickButtons = require('../services/chat-quick-buttons.service');
const replies = require('../services/quick-reply.service');
const conversations = require('../services/conversation.service');

const P = '11111111-1111-4111-8111-111111111111', I = '22222222-2222-4222-8222-222222222222';

test('botones rápidos: invitación con enlace y hasta 5 conjuntos del negocio', async () => {
  const original = db.query; let saved;
  db.query = async (sql, args) => {
    if (sql.includes('FROM entrepreneur_packages')) return { rows: args[1].filter((id) => id === P).map((id) => ({ id })) };
    if (sql.includes('INSERT INTO chat_quick_buttons')) { saved = JSON.parse(args[1]); return { rows: [] }; }
    if (sql.includes('SELECT config')) return { rows: saved ? [{ config: saved }] : [] };
    return { rows: [] };
  };
  try {
    assert.deepEqual(await quickButtons.get('org'), { invitation: null, imageButtons: [] });
    const config = await quickButtons.save('org', { invitation: { label: 'Grupo VIP', text: 'Únete a nuestro grupo: https://chat.whatsapp.com/ABC' }, imageButtons: [{ label: 'Caricatura', packageId: P }] });
    assert.equal(config.imageButtons.length, 1);
    await assert.rejects(quickButtons.save('org', { invitation: { label: 'Grupo', text: 'sin enlace' } }), /enlace/);
    await assert.rejects(quickButtons.save('org', { imageButtons: Array.from({ length: 6 }, () => ({ label: 'x', packageId: P })) }), /5 botones/);
    await assert.rejects(quickButtons.save('org', { imageButtons: [{ label: 'Otro', packageId: I }] }), /ya no existe/);
    const original2 = conversations.queueText; let sent;
    conversations.queueText = async (_o, _c, input) => { sent = input; return { id: 'm1' }; };
    try { await quickButtons.sendInvitation('org', 'conv'); assert.equal(sent.body, 'Únete a nuestro grupo: https://chat.whatsapp.com/ABC'); }
    finally { conversations.queueText = original2; }
  } finally { db.query = original; }
});

test('respuesta rápida con texto e imágenes guardadas', async () => {
  const original = db.query; let insert;
  db.query = async (sql, args) => {
    if (sql.includes('FROM entrepreneur_package_images')) return { rows: args[1].filter((id) => id === I).map((id) => ({ id })) };
    if (sql.startsWith('INSERT INTO quick_replies')) { insert = args; return { rows: [{ id: 'r1', imageIds: args[6] }] }; }
    return { rows: [] };
  };
  try {
    const created = await replies.create('org', { shortcut: '/caja', name: 'Caja', body: 'Así es la caja 📦', imageIds: [I] });
    assert.deepEqual(created.imageIds, [I]); assert.deepEqual(insert[6], [I]);
    await assert.rejects(replies.create('org', { shortcut: '/caja', name: 'Caja', body: 'x', imageIds: [P] }), /ya no existe/);
    await assert.rejects(replies.create('org', { shortcut: '/inv', name: 'Inv', body: 'x', kind: 'cta_url', ctaUrlTemplateId: P, imageIds: [I] }), /no puede llevar imágenes/);
  } finally { db.query = original; }
});

test('la primera imagen lleva el texto de la respuesta rápida como pie', async () => {
  const original = { query: db.query, existing: conversations.queueExistingMedia };
  const sent = [];
  db.query = async () => ({ rows: [{ id: I, mediaId: 'm-a', caption: 'pie guardado' }, { id: P, mediaId: 'm-b', caption: null }] });
  conversations.queueExistingMedia = async (...args) => { sent.push([args[3], args[4]]); return { id: 'x' }; };
  try {
    await conversations.queueEntrepreneurPackages('org', 'conv', { imageIds: [I, P], caption: 'Así es la caja' });
    assert.deepEqual(sent, [['m-a', 'Así es la caja'], ['m-b', null]]);
  } finally { db.query = original.query; conversations.queueExistingMedia = original.existing; }
});

test('la invitación puede ser una «Invitación con botón» guardada', async () => {
  const CTA = '33333333-3333-4333-8333-333333333333';
  const original = { query: db.query, cta: conversations.queueCtaUrl }; let saved; let sent;
  db.query = async (sql, args) => {
    if (sql.includes('FROM cta_url_templates') && sql.startsWith('SELECT id')) return { rows: args[0] === CTA ? [{ id: CTA }] : [] };
    if (sql.includes('FROM cta_url_templates')) return { rows: [{ header: null, header_image_url: 'https://img/x.jpg', body: 'Únete a nuestro grupo VIP', footer: null, button_text: 'Unirme', url: 'https://chat.whatsapp.com/ABC' }] };
    if (sql.includes('INSERT INTO chat_quick_buttons')) { saved = JSON.parse(args[1]); return { rows: [] }; }
    if (sql.includes('SELECT config')) return { rows: [{ config: saved }] };
    return { rows: [] };
  };
  conversations.queueCtaUrl = async (_o, _c, input) => { sent = input; return { id: 'm' }; };
  try {
    const config = await quickButtons.save('org', { invitation: { label: 'Grupo VIP', ctaUrlTemplateId: CTA, text: 'se ignora' } });
    assert.deepEqual(config.invitation, { label: 'Grupo VIP', ctaUrlTemplateId: CTA });
    await quickButtons.sendInvitation('org', 'conv');
    assert.deepEqual(sent, { headerImageUrl: 'https://img/x.jpg', body: 'Únete a nuestro grupo VIP', buttonText: 'Unirme', url: 'https://chat.whatsapp.com/ABC' });
    await assert.rejects(quickButtons.save('org', { invitation: { label: 'X', ctaUrlTemplateId: '44444444-4444-4444-8444-444444444444' } }), /ya no existe/);
    await assert.rejects(quickButtons.save('org', { invitation: { label: 'X' } }), /Elige una invitación/);
  } finally { db.query = original.query; conversations.queueCtaUrl = original.cta; }
});
