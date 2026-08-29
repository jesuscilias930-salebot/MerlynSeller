ALTER TABLE automation_scenarios
  ADD COLUMN trigger_examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN steps jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE automation_scenarios
SET trigger_examples = CASE key
  WHEN 'catalogo_anuncio' THEN '["catalogo", "quiero ver el catalogo", "podria enviarme su catalogo"]'::jsonb
  WHEN 'envios_nacionales' THEN '["hacen envios a toda la republica", "envian a todo mexico", "hacen envios"]'::jsonb
  ELSE '[]'::jsonb
END,
steps = CASE key
  WHEN 'catalogo_anuncio' THEN jsonb_build_array(
    jsonb_build_object('id','send_catalog','type','send_catalog','label','Enviar catálogo','caption',config->>'catalogCaption','nextStepId','confirm_catalog'),
    jsonb_build_object('id','confirm_catalog','type','wait_reply','label','Esperar confirmación','branches',jsonb_build_array(jsonb_build_object('id','confirmed','name','Confirmó que puede abrirlo','examples',jsonb_build_array('si','sí','claro','ya lo abri','ya lo abrí'),'nextStepId','ask_goal'))),
    jsonb_build_object('id','ask_goal','type','send_text','label','Preguntar objetivo','body',config->>'goalQuestion','nextStepId','wait_goal'),
    jsonb_build_object('id','wait_goal','type','wait_reply','label','Esperar objetivo','branches',jsonb_build_array(jsonb_build_object('id','entrepreneur','name','Quiere emprender','examples',jsonb_build_array('emprender','quiero emprender','iniciar mi negocio'),'nextStepId','ask_boxes'))),
    jsonb_build_object('id','ask_boxes','type','send_text','label','Ofrecer cajas emprendedoras','body',config->>'entrepreneurQuestion','nextStepId','wait_catalog_again'),
    jsonb_build_object('id','wait_catalog_again','type','wait_reply','label','Esperar siguiente respuesta','branches',jsonb_build_array(jsonb_build_object('id','catalog_again','name','Vuelve a pedir catálogo','examples',jsonb_build_array('catalogo','me gustaria ver el catalogo'),'nextStepId','close'))),
    jsonb_build_object('id','close','type','send_text','label','Mensaje de cierre','body',config->>'closingMessage','nextStepId','move_column'),
    jsonb_build_object('id','move_column','type','move_column','label','Mover a columna','columnId',config->>'completionColumnId','nextStepId','end'),
    jsonb_build_object('id','end','type','end','label','Finalizar escenario')
  )
  WHEN 'envios_nacionales' THEN jsonb_build_array(
    jsonb_build_object('id','shipping_message','type','send_text','label','Responder sobre envíos','body',config->>'shippingMessage','nextStepId','evidence'),
    jsonb_build_object('id','evidence','type','send_media','label','Enviar fotos de evidencia','items',coalesce(config->'evidence','[]'::jsonb),'nextStepId','ask_catalog'),
    jsonb_build_object('id','ask_catalog','type','send_text','label','Ofrecer catálogo','body',config->>'catalogQuestion','nextStepId','wait_catalog'),
    jsonb_build_object('id','wait_catalog','type','wait_reply','label','Esperar respuesta sobre catálogo','branches',jsonb_build_array(jsonb_build_object('id','yes','name','Quiere catálogo','examples',jsonb_build_array('si','sí','claro','por favor'),'nextStepId','send_catalog'))),
    jsonb_build_object('id','send_catalog','type','send_catalog','label','Enviar catálogo','caption',config->>'catalogCaption','nextStepId','ask_goal'),
    jsonb_build_object('id','ask_goal','type','send_text','label','Preguntar objetivo','body',config->>'goalQuestion','nextStepId','wait_goal'),
    jsonb_build_object('id','wait_goal','type','wait_reply','label','Esperar objetivo','branches',jsonb_build_array(jsonb_build_object('id','entrepreneur','name','Quiere emprender','examples',jsonb_build_array('emprender','quiero emprender'),'nextStepId','ask_boxes'))),
    jsonb_build_object('id','ask_boxes','type','send_text','label','Ofrecer cajas','body',config->>'entrepreneurQuestion','nextStepId','wait_boxes'),
    jsonb_build_object('id','wait_boxes','type','wait_reply','label','Esperar confirmación de cajas','branches',jsonb_build_array(jsonb_build_object('id','yes','name','Quiere ver cajas','examples',jsonb_build_array('si','sí','claro','por favor'),'nextStepId','send_boxes'))),
    jsonb_build_object('id','send_boxes','type','send_text','label','Enviar cajas','body',coalesce((SELECT string_agg(trim(coalesce(box->>'title','') || E'\n' || coalesce(box->>'description','')), E'\n\n') FROM jsonb_array_elements(coalesce(config->'boxes','[]'::jsonb)) box),''),'nextStepId','end'),
    jsonb_build_object('id','end','type','end','label','Finalizar escenario')
  )
  ELSE steps
END;

-- Preserve any lead that was already in one of the original guided flows.
UPDATE conversation_scenario_states
SET step = CASE
  WHEN scenario_key = 'catalogo_anuncio' AND step = 'await_catalog_confirmation' THEN 'confirm_catalog'
  WHEN scenario_key = 'catalogo_anuncio' AND step = 'await_goal' THEN 'wait_goal'
  WHEN scenario_key = 'catalogo_anuncio' AND step = 'await_catalog_followup' THEN 'wait_catalog_again'
  WHEN scenario_key = 'envios_nacionales' AND step = 'await_catalog' THEN 'wait_catalog'
  WHEN scenario_key = 'envios_nacionales' AND step = 'await_goal' THEN 'wait_goal'
  WHEN scenario_key = 'envios_nacionales' AND step = 'await_boxes_confirmation' THEN 'wait_boxes'
  ELSE step
END
WHERE completed_at IS NULL;

CREATE INDEX automation_scenarios_trigger_idx ON automation_scenarios USING gin (trigger_examples);
