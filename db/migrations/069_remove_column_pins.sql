-- Se quita el «fijado» 📌 de los leads: las reglas de columna y el remarketing ya no fijan, y
-- escenarios y automatizaciones pueden mover cualquier lead. Se liberan los que estaban fijados.
UPDATE conversations SET column_pinned_at = NULL, column_pinned_rule_id = NULL WHERE column_pinned_at IS NOT NULL;
