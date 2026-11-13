# My Palatto

Aplicación móvil para pedidos, cocina, cobros y la caja de un solo negocio, con un único menú y una única caja. React + TypeScript + Vite + Tailwind CSS + Supabase.

## Ejecutar

```sh
npm install
npm run dev
```

La configuración de este equipo está en `.env.local` (ignorada por Git). Para otro equipo, copia `.env.example` a `.env.local` y completa la clave pública de Supabase. Nunca uses una clave `service_role` en el frontend.

## Proyecto Supabase

Proyecto: `uosswtbajrjcegyaqwdb`.

Migraciones del proyecto, en orden:

- `20260917050348_palatto_initial_schema.sql`: tablas, funciones, permisos, comprobantes y Realtime.
- `20260917050525_palatto_indexes_and_rls_plans.sql`: índices y optimización de políticas.
- `20260917122920_visual_menu_cash_transfers.sql`: fotos de menú, transferencias entre cajas y bucket `menu-images`.
- `20260917160000_takeaway_fees.sql`: tarifas para llevar y pedidos para servir/llevar.
- `20260917170000_two_order_statuses.sql`: estados `en_proceso` y `completado`.
- `20260919090000_carreta_payment_allocation.sql`: asignación de cobros y correcciones para Carreta.
- `20261111120000_inventory.sql`: insumos, movimientos de stock y permisos.
- `20261111130000_delete_order.sql`: eliminación de pedidos sin cobrar y registro en `deleted_orders`.
- `20261111140000_single_business_split_payments.sql`: un solo negocio, pagos divididos por persona y movimientos por tipo.
- `20261112073211_account_security_and_push_subscriptions.sql`: cambio obligatorio de contraseña temporal y almacenamiento privado de suscripciones push.
- `20261112090000_order_total_adjustment.sql`: total ajustable al cobrar y reparto proporcional entre líneas.
- `20261113090000_single_menu_daily_orders.sql`: un solo menú, una sola caja, numeración diaria, tarifa para llevar por línea, borrado lógico de productos y facturas opcionales en gastos.

Tablas: `profiles`, `products`, `shifts`, `orders`, `order_payments`, `movements`, `audits`, `supplies`, `supply_movements`, `deleted_orders`. Todas tienen RLS. Las escrituras del cliente solo pasan por funciones que comprueban el rol actual. El bucket `receipts` es privado, acepta imágenes de hasta 5 MB y usa enlaces temporales para visualizarlas.

La Edge Function `manage-users` está desplegada. Verifica el token con `auth.getUser` y comprueba que el usuario sea un superadmin activo antes de usar la clave de servicio del entorno. La validación JWT de la pasarela está desactivada porque la función realiza su propia autenticación, compatible con claves públicas modernas.

### Cuenta inicial

El proyecto ya tiene una cuenta activa con rol `superadmin` y perfil asociado. Desde Equipo se crean las demás cuentas y se asignan roles. No existe registro público ni una ruta de autoasignación de superadmin.

El menú se administra desde la pestaña Menú. El administrador debe cargar los productos y precios reales. El acceso requiere una cuenta de Supabase; no hay modo de demostración.

## Reglas implementadas

- Cinco roles disponibles: Superadmin, Administrador, Cocinero, Mesera y Visualizador. `carreta` queda como valor interno histórico para clasificar aguas y colas en reportes, no como negocio ni caja separada.
- Un solo menú y una sola caja para Palatto. Cada producto puede marcarse como agua o cola; ese check alimenta el resumen del día sin separar la caja.
- Administrador gestiona el menú y la caja. Superadmin tiene acceso total.
- Cocinero toma y cobra pedidos y consulta la caja. Mesera y Mesero toman, modifican y cobran pedidos. Visualizador solo consulta.
- No hay turnos que abrir ni cerrar. Los productos activos siempre están disponibles y la caja siempre opera.
- Pedidos numerados `#1`, `#2`… y reiniciados cada día en la zona de Ecuador. La lista muestra los pedidos en proceso por orden de llegada y los completados del más reciente al más antiguo.
- Un pedido pendiente se cobra desde su tarjeta o directamente al crearlo con «Cobrar ahora». Confirmar el pago es lo que registra la venta del día.
- Los pedidos sin cobrar pueden eliminarse con un motivo obligatorio. La función `delete_order` rechaza pedidos cobrados, con movimientos o con pagos divididos, valida la versión y guarda número, cliente, líneas, total, motivo y usuario en `deleted_orders`, visible solo para Superadmin y Administrador.
- Eliminar un producto del menú es un borrado lógico: deja de ofrecerse, pero los pedidos históricos conservan nombre, precio y tarifa.
- Importes almacenados en centavos. Precios, tarifas y condición de agua o cola se resuelven en PostgreSQL, ignorando importes enviados por el navegador.
- Efectivo exige importe recibido y calcula suelto. Transferencia exige una imagen cargada en Storage antes de confirmar.
- Cada pedido genera un único movimiento de caja por el total cobrado, con el medio real del pago. No se crean movimientos por producto ni por caja separada.
- Una cuenta se puede dividir por persona sin crear otro pedido: se eligen los productos de cada persona y su forma de pago. La tabla `order_payments` guarda cada parte; el pedido se marca cobrado al cubrir el total. Mientras haya pagos parciales se bloquean `pay_order`, `edit_order` y `delete_order`.
- Al cobrar se puede modificar el total final sin pedir motivo. El ajuste queda en `orders.adjustment`, se audita y aparece en el detalle del pedido, en los reportes y en el CSV.
- Los movimientos de caja distinguen `ingreso`, `gasto`, `retiro`, `cobro` y `correccion`. Un gasto es una compra o salida operativa; un retiro es dinero que sale del negocio. Los gastos aceptan una factura opcional.
- Los pedidos cobrados no se editan ni se eliminan. Para corregir un cobro se registra el movimiento de caja correspondiente.
- Versionado y bloqueo transaccional impiden cobros duplicados y modificaciones simultáneas obsoletas.
- Los movimientos no se borran: las correcciones se registran como nuevos ajustes con motivo e importe.

## Interfaz móvil

La app está diseñada primero para el teléfono y se maneja con una mano:

- **Barra inferior** con cinco accesos: Inicio, Insumos, Nuevo (botón central elevado), Reportes y Menú. La caja se abre desde el bloque de saldo de Inicio.
- **Paleta cálida** tomada del logo: crema, tinta, cobre para acciones de marca, verde para dinero y rojo solo para acciones destructivas.
- **Tipografía** Bricolage Grotesque para títulos, importes y números; Manrope para el resto de la interfaz.
- **Botones de al menos 48 px** para las acciones importantes; el cobro y el envío a cocina usan 56 px. Formularios, steppers y hojas inferiores respetan áreas táctiles y `safe-area-inset-bottom`.
- **Pedidos como tarjetas** con resumen, estado y botón Cobrar. El detalle se abre en una hoja inferior con Cobrar, Editar y Eliminar.
- **Cobro simple o dividido**: total destacado y editable, efectivo o transferencia, montos rápidos y suelto. «Dividir cuenta» permite marcar qué productos paga cada persona y registrar pagos parciales sin duplicar el pedido.
- **Menú con buscador** y un indicador discreto de la tarifa para llevar. Los productos se crean sin negocio ni categoría; solo se marca si son agua o cola.
- **Editor de pedido por línea**: permite que algunas unidades de un producto vayan para llevar y el resto para servir, con atajos «Todo para servir» y «Todo para llevar».
- Sin desbordamiento horizontal a 390 px; las hojas inferiores se convierten en diálogos centrados en pantallas grandes.

## Validación

```sh
npm test
npm run lint
npm run build
node --env-file=.env.local scripts/verify-connection.mjs
```

Las pruebas ejecutan las migraciones en PostgreSQL mediante PGlite, con los esquemas de Auth y Storage simulados, y comprueban permisos, menú único, numeración diaria, tarifas para llevar, una sola caja, pagos divididos, tipos de movimiento, comprobantes, eliminación de pedidos y cobros duplicados. No sustituyen una prueba de acceso real con la primera cuenta.

La prueba de conexión consulta el proyecto remoto sin modificar datos: verifica Auth, rechazo de acceso anónimo a las tablas y protección de `manage-users`.

El asesor de seguridad señala las RPC `SECURITY DEFINER` accesibles a usuarios autenticados. Su exposición es deliberada: todas las operaciones públicas validan roles y usan un `search_path` fijo; los auxiliares internos no tienen permiso de ejecución para clientes. Referencia: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

## Puesta en servicio

La cuenta Superadmin ya existe y el esquema remoto está actualizado con la migración del 13 de noviembre de 2026. El menú quedó vacío tras reiniciar los productos; falta cargar los productos y precios reales, probar el inicio de sesión con esa cuenta y publicar el frontend en el alojamiento que se elija. La aplicación requiere conexión a Internet.

### Publicar en Vercel

El repositorio ya incluye `vercel.json` con la configuración de Vite y la reescritura a `index.html`. Para publicarlo:

1. Importa el repositorio en Vercel y deja el framework detectado como **Vite**. Build: `npm run build`; salida: `dist`.
2. En **Settings → Environment Variables** agrega, para Production, Preview y Development:
   - `VITE_SUPABASE_URL` = `https://uosswtbajrjcegyaqwdb.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = la clave pública `anon` del proyecto (la misma de `.env.local`). Nunca uses `service_role`.
   - `VITE_VAPID_PUBLIC_KEY` = clave pública VAPID usada por el servicio push. Es pública y la aplicación la necesita al construir.
3. Despliega. Las variables `VITE_*` se incrustan al construir, así que después de cambiarlas hay que volver a desplegar.
4. En Supabase, **Authentication → URL Configuration**, define el dominio de producción como **Site URL** y agrégalo a **Redirect URLs** (`https://tu-dominio.vercel.app/**`). El inicio de sesión con correo y contraseña no necesita callback, pero esto evita bloqueos de seguridad y cubre futuros enlaces de recuperación.
5. Comprueba el dominio publicado: inicio de sesión, carga de pedidos, caja, cobro dividido y una foto de menú.

No se requiere `vercel dev` ni un servidor Node: es un sitio estático que habla directo con Supabase.

### Cuentas, instalación y notificaciones push

Superadmin crea cada cuenta con una contraseña temporal generada desde Equipo. La persona debe elegir una contraseña propia en su primer ingreso. Luego puede cambiarla desde Tu cuenta → Seguridad. La contraseña temporal debe compartirse de forma privada.

La aplicación incluye un manifiesto PWA y un service worker para instalar Palatto desde el navegador. En Android/Chrome usa **Instalar aplicación**; en iPhone/iPad abre Compartir → **Añadir a pantalla de inicio**. La instalación requiere el dominio de producción por HTTPS.

Las notificaciones push avisan a todos los usuarios activos suscritos, incluida la cuenta que realizó el movimiento, cuando se crean o editan pedidos, se registran cobros, cambios de caja, menú, cuentas del equipo o insumos. No se notifican cambios de navegación ni texto sin guardar. Cada dispositivo debe activar las notificaciones. Las notificaciones se apilan en pantalla y las push usan una etiqueta única para que una no oculte a la siguiente. Para completar su envío en producción:

1. Genera un par VAPID una sola vez con `npx web-push generate-vapid-keys` y conserva ambas claves. No vuelvas a generarlas después de que los usuarios se suscriban.
2. En **Vercel → Project → Settings → Environment Variables**, crea `VITE_VAPID_PUBLIC_KEY` con la clave pública para Production, Preview y Development; luego vuelve a desplegar. Los cambios de variables solo llegan a despliegues nuevos.
3. En **Supabase → Project Settings → Edge Functions → Secrets**, agrega `PALATTO_VAPID_PUBLIC_KEY` con esa misma clave pública, `PALATTO_VAPID_PRIVATE_KEY` con la clave privada y `PALATTO_VAPID_SUBJECT` con un contacto real, por ejemplo `mailto:tu-correo@dominio.com`. La clave privada se guarda solo en Supabase; nunca la pongas en Vercel ni en el frontend.
4. Inicia sesión en Palatto desde un navegador compatible, abre Tu cuenta → Notificaciones y pulsa **Activar notificaciones**. Cada dispositivo debe aceptar el permiso.

La migración y las funciones Edge `manage-users` y `palatto-push` están aplicadas al proyecto Supabase. El envío requiere el par VAPID en Supabase, la clave pública en el frontend desplegado y que cada dispositivo tenga una suscripción activa. Después de modificar la función Edge, vuelve a desplegar `palatto-push` en Supabase.



### Reportes y análisis de ventas
La pestaña **Reportes** calcula todo desde los pedidos cobrados, sin tablas nuevas. Incluye:

- Ventas del día, pedidos cobrados, ticket promedio y artículos vendidos.
- Filtros Hoy, Ayer, 7 días, Este mes y Todo.
- Separación por medio de pago y dinero vendido en aguas o colas.
- Ventas por hora con el pico destacado, productos más vendidos, ventas por categoría y tendencia de los últimos 14 días.
- Exportación CSV de las líneas vendidas en el rango elegido.

Las fechas y horas usan `America/Guayaquil`. Solo cuentan los pedidos con `paid = true` y la fecha de venta es `paid_at`, fijada al confirmar el pago; un pedido pendiente no se muestra como venta. El inicio muestra un resumen de ventas de hoy con acceso directo a Reportes.

### Insumos e inventario
La pestaña **Insumos** permite registrar carne, papa, pan y cualquier otro recurso con su unidad, stock mínimo, costo y movimientos:

- **Entrada** suma stock (compras o reposiciones).
- **Consumo** resta stock y nunca permite dejarlo negativo.
- **Ajuste** fija el stock real de un conteo físico.
- Cada movimiento guarda cantidad, motivo, usuario y fecha. La lista resalta los insumos agotados o por debajo del mínimo y calcula el valor del inventario.

La migración `20261111120000_inventory.sql` crea las tablas `supplies` y `supply_movements`, sus permisos y las funciones `save_supply` y `register_supply_movement`. Está aplicada al proyecto remoto desde el 11 de noviembre de 2026 y verificada con `node --env-file=.env.local scripts/verify-connection.mjs` y una prueba transaccional de los RPC. `scripts/activate-inventory.sql` queda como versión idempotente para otro entorno.

Si las tablas no existen (por ejemplo, en un proyecto nuevo), la app detecta el caso y guarda el inventario en el navegador (`localStorage`), mostrando un aviso en pantalla. Los reportes no dependen de esta migración.

### Inicio, caja y menú visual
El inicio muestra el saldo total de la caja como bloque principal, el vendido hoy, una carita que evoluciona según lo vendido y dos accesos con los cobros y la cantidad de pedidos de cada medio: efectivo y transferencia. Al pulsar cualquiera de ellos se abre la caja única. No hay cajas separadas ni transferencias entre cajas.

La caja muestra el saldo total y su desglose por medio, permite ingresar dinero, registrar gastos y retirar. Cada gasto acepta una factura opcional (foto o archivo) que luego puede verse desde el movimiento. Los cobros entran automáticamente al confirmar el pago.

El resumen del día muestra lo vendido hoy, la cantidad de pedidos cobrados, el dinero hecho en aguas o colas y el saldo en caja, además del desglose de cobros y movimientos del día.

Las fotos se cargan desde Menú al crear o editar productos (JPG, PNG o WebP, hasta 5 MB). También se puede subir una foto desde el archivo, no solo tomarla con la cámara. Las imágenes del menú son públicas; los comprobantes y facturas siguen siendo privados. El número mostrado en una orden nueva es provisional hasta que PostgreSQL asigna el definitivo al guardarla.

### Tarifa para llevar
La tarifa se configura por producto en centavos por unidad. Al activarla, el editor propone automáticamente `0.25`. En el menú se indica de forma discreta qué productos la aplican.

La tarifa se maneja por línea: un pedido puede tener 2 hamburguesas para la mesa y 1 para llevar. PostgreSQL calcula y guarda el precio base, la tarifa y cuántas unidades de cada línea son para llevar, ignorando importes enviados por el navegador. Las tarifas no modifican pedidos anteriores.

### Un solo negocio y pagos divididos
La migración `20261111140000_single_business_split_payments.sql` está aplicada al proyecto remoto desde el 11 de noviembre de 2026. Reutiliza el valor interno `carreta` para clasificar aguas y colas, elimina la exigencia de turnos, separa gasto de retiro y crea `order_payments` con la función `add_split_payment`. Los pedidos históricos conservan sus movimientos y se normalizaron a los nuevos tipos de movimiento.

### Total ajustable al cobrar
La migración `20261112090000_order_total_adjustment.sql` está aplicada al proyecto remoto desde el 12 de noviembre de 2026. Agrega `orders.adjustment` y amplía `pay_order` con `p_total`. El total final se puede editar siempre al cobrar, sin pedir un motivo. El ajuste se audita y aparece en el detalle del pedido, en los reportes y en el CSV. `orders.adjustment_reason` queda sin uso.

### Un solo menú, una sola caja y numeración diaria
La migración `20261113090000_single_menu_daily_orders.sql` está aplicada al proyecto remoto desde el 13 de noviembre de 2026. Agrega `products.is_drink`, hace lógico el borrado de productos, crea `orders.order_day` y `orders.paid_at`, renumera los pedidos por día con `unique(order_day, number)`, guarda la cantidad para llevar por línea (`takeaway_quantity`) y unifica los cobros en la caja `palatto`. También agrega factura opcional a `movements` y `supply_purchases`, y actualiza las RPC `save_product`, `delete_product`, `create_order`, `edit_order`, `pay_order`, `cash_movement` y `register_supply_purchase`. Los productos se reiniciaron con `delete from public.products;`; los pedidos y movimientos históricos se conservaron.

### Conexión MCP de OpenCode
El MCP remoto de Supabase está configurado con el `project_ref` de Palatto y autenticado por OAuth. El token se guarda en `~/.local/share/opencode/mcp-auth.json`, fuera del repositorio. La configuración solo contiene el `project_ref` y las funciones habilitadas.
