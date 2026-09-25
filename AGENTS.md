# Instrucciones del proyecto

## Git al finalizar cada tarea

- Después de implementar y validar los cambios de una tarea, crea un commit local con un mensaje descriptivo en español.
- Incluye únicamente los cambios de esa tarea. Revisa git status y el diff antes de agregar archivos; no uses git add . si incluye cambios ajenos.
- Preserva los cambios preexistentes del usuario y no incluyas archivos ya preparados por otra tarea sin autorización.
- Nunca incluyas secretos, archivos .env con credenciales ni archivos generados.
- Si las validaciones fallan, hay conflictos o no puedes separar cambios ajenos, informa antes de crear el commit.
- No crees commits vacíos ni omitas verificaciones mediante --no-verify.
- Usa la rama actual; no cambies de rama ni de remoto sin indicación del usuario.
- Ejecuta git push únicamente cuando el usuario lo solicite explícitamente. Terminar una tarea o crear un commit NO autoriza el push.
- Una autorización de push se aplica a la solicitud concreta, no a tareas futuras. Si la rama o el destino son ambiguos, solicita aclaración.
- Nunca uses force push.
- Reporta el hash del commit y aclara si permanece local. Cuando se autorice push, verifica y reporta su resultado.
