insert into packages (code, name, sort_order)
values
  ('plus', 'Plus', 10),
  ('5xpro', '5xpro', 20),
  ('20xpro', '20xpro', 30)
on conflict (code) do update
set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true;

update packages
set is_default = (code = 'plus');

insert into sales_platforms (code, name, sort_order)
values
  ('taobao', '淘宝', 10),
  ('xianyu', '闲鱼', 20),
  ('pinduoduo', '拼多多', 30)
on conflict (code) do update
set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = true;

update sales_platforms
set is_default = (code = 'taobao');

-- 当前没有默认下游对象，保留空表即可。
