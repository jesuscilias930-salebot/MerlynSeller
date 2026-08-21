// Por ahora no hay base de datos: los eventos solo se registran en consola.
// El día que se agregue una BD (MongoDB, Postgres, etc.), solo este archivo
// necesita cambiar; el resto de las capas no se ven afectadas.

exports.save = async (event) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(event, null, 2));
};
