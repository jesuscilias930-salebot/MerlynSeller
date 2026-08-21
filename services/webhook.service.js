const { log } = require('node:console');
const eventRepository = require('../repositories/event.repository');

// Valida el modo y token contra el verify_token configurado
exports.isValidToken = (mode, token) => {
  console.log("log on valid ", mode, token, process.env.VERIFY_TOKEN);
  return mode === 'subscribe' && token === process.env.VERIFY_TOKEN;
};

// Procesa el evento recibido del webhook
exports.processEvent = async (body) => {
  // Aquí puedes agregar lógica de negocio en el futuro:
  // parsear el tipo de mensaje, validar estructura, etc.
  await eventRepository.save(body);
};
