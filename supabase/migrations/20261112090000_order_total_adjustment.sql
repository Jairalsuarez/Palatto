-- Total ajustable al cobrar, con motivo obligatorio y reparto proporcional ------

alter table public.orders
  add column if not exists adjustment integer not null default 0,
  add column if not exists adjustment_reason text;

drop function if exists public.pay_order(uuid,integer,public.payment_method,integer,text);

create or replace function public.pay_order(
 p_id uuid,
 p_version integer,
 p_method public.payment_method,
 p_received integer,
 p_receipt text default null,
 p_total integer default null,
 p_reason text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
 o public.orders;
 b public.business;
 amount integer;
 full_amount integer;
 final_amount integer;
 items_palatto integer;
 palatto_amount integer;
 v_adjustment integer;
 reason text;
begin
 perform public.require_writer();
 perform pg_advisory_xact_lock(81001);
 select * into o from public.orders where id=p_id for update;
 if not found or o.version<>p_version then raise exception 'El pedido cambió. Actualiza y vuelve a intentarlo.'; end if;
 if o.paid then raise exception 'Este pedido ya está cobrado.'; end if;
 if exists(select 1 from public.order_payments where order_id=p_id) then
  raise exception 'Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.';
 end if;
 if p_method is null then raise exception 'Selecciona el método de pago.'; end if;

 select sum((i->>'price')::integer*(i->>'quantity')::integer) into full_amount
 from jsonb_array_elements(o.items) i;
 if full_amount is null or full_amount<=0 then raise exception 'El pedido no tiene un total válido.'; end if;

 final_amount := coalesce(p_total,full_amount);
 if final_amount<=0 or final_amount>100000000 then raise exception 'El total debe ser un importe mayor a cero.'; end if;
 v_adjustment := final_amount-full_amount;
 reason := nullif(trim(coalesce(p_reason,'')),'');
 if v_adjustment<>0 and (reason is null or length(reason)<3 or length(reason)>450) then
  raise exception 'Explica el motivo del ajuste al total.';
 end if;

 if p_method='efectivo' and (p_received is null or p_received<final_amount) then raise exception 'Efectivo insuficiente.'; end if;
 if p_method='transferencia' then perform public.check_receipt(p_receipt); end if;

 select coalesce(sum((i->>'price')::integer*(i->>'quantity')::integer),0) into items_palatto
 from jsonb_array_elements(o.items) i where i->>'business'='palatto';
 if items_palatto<=0 then
  palatto_amount := 0;
 elsif items_palatto>=full_amount then
  palatto_amount := final_amount;
 else
  palatto_amount := round(final_amount::numeric*items_palatto/full_amount)::integer;
 end if;

 for b in select distinct (i->>'business')::public.business from jsonb_array_elements(o.items) i loop
  amount := case when b='palatto' then palatto_amount else final_amount-palatto_amount end;
  if amount>0 then
   insert into public.movements(business,amount,method,reason,order_id,shift_id,actor,kind)
   values(b,amount,p_method,'Cobro de pedido #'||o.number,p_id,null,auth.uid(),'cobro');
  end if;
 end loop;

 update public.orders set paid=true,status='completado',method=p_method,
  receipt=case when p_method='transferencia' then p_receipt else null end,
  split_payment=false,adjustment=v_adjustment,adjustment_reason=case when v_adjustment<>0 then reason else null end,
  version=version+1 where id=p_id;

 insert into public.audits(order_id,actor,reason,before_data,after_data)
 values(p_id,auth.uid(),'Cobro: '||p_method||case when v_adjustment<>0 then ' · Ajuste: '||reason else '' end,to_jsonb(o),
  jsonb_build_object(
   'status','completado','paid',true,'received',p_received,
   'change',case when p_method='efectivo' then p_received-final_amount else 0 end,
   'total',final_amount,'original_total',full_amount,'adjustment',v_adjustment,'reason',reason,
   'palatto',palatto_amount,'carreta',final_amount-palatto_amount));
end $$;

revoke all on function public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text) from public,anon,authenticated;
grant execute on function public.pay_order(uuid,integer,public.payment_method,integer,text,integer,text) to authenticated;
