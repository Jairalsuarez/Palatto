# My Palatto

Aplicación móvil para pedidos, cocina, cobros y las dos cajas de un mismo negocio: caja principal y registro separado de aguas y colas. React + TypeScript + Vite + Tailwind CSS + Supabase.

## Ejecutar

```sh
npm install
npm run dev
```

La configuración de este equipo está en `.env.local` (ignorada por Git). Para otro equipo, copia `.env.example` a `.env.local` y completa la clave pública de Supabase. Nunca uses una clave `service_role` en el frontend.

## Proyecto Supabase

Proyecto: `uosswtbajrjcegyaqwdb`.

Migraciones aplicadas y sincronizadas con los nombres locales:

- `20260917050348_palatto_initial_schema.sql`: tablas, funciones, permisos, comprobantes y Realtime.
- `20260917050525_palatto_indexes_and_rls_plans.sql`: índices y optimización de políticas.
- `20260917122920_visual_menu_cash_transfers.sql`: fotos de menú, transferencias entre cajas y bucket `menu-images`.
- `20260917160000_takeaway_fees.sql`: tarifas para llevar y pedidos para servir/llevar.
- `20260917170000_two_order_statuses.sql`: estados `en_proceso` y `completado`.
- `20260919090000_carreta_payment_allocation.sql`: asignación de cobros y correcciones para Carreta.
- `20261111120000_inventory.sql`: insumos, movimientos de stock y permisos.
- `20261111130000_delete_order.sql`: eliminación de pedidos sin cobrar y registro en `deleted_orders`.
- `20261111140000_single_business_split_payments.sql`: un solo negocio, cajas principal y de aguas y colas, movimientos por tipo y pagos divididos por persona.
- `20261112073211_account_security_and_push_subscriptions.sql`: cambio obligatorio de contraseña temporal y almacenamiento privado de suscripciones push.
- `20261112090000_order_total_adjustment.sql`: total ajustable al cobrar, motivo obligatorio y reparto proporcional entre cajas.

Tablas: `profiles`, `products`, `shifts`, `orders`, `order_payments`, `movements`, `audits`, `supplies`, `supply_movements`, `deleted_orders`. Todas tienen RLS. Las escrituras del cliente solo pasan por funciones que comprueban el rol actual. El bucket `receipts` es privado, acepta imágenes de hasta 5 MB y usa enlaces temporales para visualizarlas.

La Edge Function `manage-users` está desplegada. Verifica el token con `auth.getUser` y comprueba que el usuario sea un superadmin activo antes de usar la clave de servicio del entorno. La validación JWT de la pasarela está desactivada porque la función realiza su propia autenticación, compatible con claves públicas modernas.

### Cuenta inicial

El proyecto ya tiene una cuenta activa con rol `superadmin` y perfil asociado. Desde Equipo se crean las demás cuentas y se asignan roles. No existe registro público ni una ruta de autoasignación de superadmin.

Hay dos productos de prueba en el menú. El administrador debe reemplazarlos por los productos y precios reales. El acceso requiere una cuenta de Supabase; no hay modo de demostración.

## Reglas implementadas

- Cinco roles disponibles: Superadmin, Administrador, Cocinero, Mesera y Visualizador. `carreta` queda como valor interno histórico para clasificar productos y movimientos de aguas y colas, no como negocio separado.
- Un solo negocio, Palatto. Las aguas y colas se venden con el mismo menú y el mismo pedido, pero su dinero se registra en la caja de aguas y colas, separado de la caja principal.
- Administrador gestiona el menú y ambos registros de caja de Palatto. Superadmin tiene acceso total.
- Cocinero toma y cobra pedidos, consulta las cajas y edita pedidos cobrados. Mesera toma, modifica y cobra pedidos. Visualizador solo consulta.
- No hay turnos que abrir ni cerrar. Los productos activos siempre están disponibles y las cajas siempre operan.
- Pedidos numerados y listados como tarjetas en orden de llegada, con botón grande para cobrar. Estados: en_proceso y completado. Cualquier pedido pendiente se puede cobrar desde su tarjeta; confirmar el pago lo completa automáticamente.
- Los pedidos sin cobrar pueden eliminarse con un motivo obligatorio. La función `delete_order` rechaza pedidos cobrados, con movimientos o con pagos divididos, valida la versión y guarda número, cliente, líneas, total, motivo y usuario en `deleted_orders`, visible solo para Superadmin y Administrador. Un pedido cobrado se corrige o se ajusta desde caja; no se borra.
- Importes almacenados en centavos. Precios y pertenencia a cada negocio se resuelven en PostgreSQL, ignorando importes enviados por el navegador.
- Efectivo exige importe recibido y calcula suelto. Transferencia exige una imagen cargada en Storage antes de confirmar.
- Un pedido mixto genera movimientos independientes por caja usando el medio real del cobro. La caja de aguas y colas acepta efectivo y transferencia. El suelto no se contabiliza como venta.
- Una cuenta se puede dividir por persona sin crear otro pedido: se eligen los productos de cada persona y su forma de pago. La tabla `order_payments` guarda cada parte; el pedido se marca cobrado al cubrir el total. Mientras haya pagos parciales se bloquean `pay_order`, `edit_order` y `delete_order`.
- Al cobrar se puede modificar el total final, con un motivo obligatorio cuando cambia. El ajuste queda en `orders.adjustment` y `orders.adjustment_reason`, se audita y se reparte proporcionalmente entre la caja principal y la de aguas y colas.
- Los movimientos de caja distinguen `ingreso`, `gasto`, `retiro`, `cobro`, `correccion` y `transferencia`. Un gasto es una compra o salida operativa; un retiro es dinero que sale del negocio. Ambos se muestran por separado.
- Solo Superadmin puede transferir entre cajas. Requiere saldo suficiente en el medio elegido y motivo; genera dos asientos vinculados en una transacción.
- Pedidos cobrados admiten correcciones con motivo, salvo que tengan pagos divididos. El historial conserva la versión anterior y agrega diferencias al libro de movimientos. Si cambia el total se cobra o devuelve la diferencia usando el medio original; una transferencia adicional o devolución requiere comprobante.
- Versionado y bloqueo transaccional impiden cobros duplicados y modificaciones simultáneas obsoletas.
- Los movimientos no se borran: las correcciones se registran como nuevos ajustes con motivo e importe.

## Interfaz móvil

La app está diseñada primero para el teléfono y se maneja con una mano:

- **Barra inferior** con cinco accesos: Inicio, Caja, Nuevo (botón central elevado), Reportes y Menú. Insumos y Equipo viven en la hoja de cuenta del avatar.
- **Paleta cálida** tomada del logo: crema, tinta, cobre para acciones de marca, verde para dinero y rojo solo para acciones destructivas.
- **Tipografía** Bricolage Grotesque para títulos, importes y números; Manrope para el resto de la interfaz.
- **Botones de al menos 48 px** para las acciones importantes; el cobro y el envío a cocina usan 56 px. Formularios, steppers y hojas inferiores respetan áreas táctiles y `safe-area-inset-bottom`.
- **Pedidos como tarjetas** con resumen, estado y botón Cobrar. El detalle se abre en una hoja inferior con Cobrar, Editar y Eliminar.
- **Cobro simple o dividido**: total destacado, efectivo o transferencia, montos rápidos y suelto. «Dividir cuenta» permite marcar qué productos paga cada persona y registrar pagos parciales sin duplicar el pedido.
- Sin desbordamiento horizontal a 390 px; las hojas inferiores se convierten en diálogos centrados en pantallas grandes.

## Validación

```sh
npm test
npm run lint
npm run build
node --env-file=.env.local scripts/verify-connection.mjs
```

Las pruebas ejecutan las migraciones en PostgreSQL mediante PGlite, con los esquemas de Auth y Storage simulados, y comprueban permisos, separación de cajas, pagos divididos, tipos de movimiento, comprobantes, eliminación de pedidos y cobros duplicados. No sustituyen una prueba de acceso real con la primera cuenta.

La prueba de conexión consulta el proyecto remoto sin modificar datos: verifica Auth, rechazo de acceso anónimo a las tablas y protección de `manage-users`.

El asesor de seguridad señala las RPC `SECURITY DEFINER` accesibles a usuarios autenticados. Su exposición es deliberada: todas las operaciones públicas validan roles y usan un `search_path` fijo; los auxiliares internos no tienen permiso de ejecución para clientes. Referencia: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

## Puesta en servicio

La cuenta Superadmin ya existe y el esquema remoto está actualizado. Falta cargar el menú y los precios reales (hoy hay dos productos de prueba), probar el inicio de sesión con esa cuenta y publicar el frontend en el alojamiento que se elija. La aplicación requiere conexión a Internet.

### Publicar en Vercel

El repositorio ya incluye `vercel.json` con la configuración de Vite y la reescritura a `index.html`. Para publicarlo:

1. Importa el repositorio en Vercel y deja el framework detectado como **Vite**. Build: `npm run build`; salida: `dist`.
2. En **Settings → Environment Variables** agrega, para Production, Preview y Development:
   - `VITE_SUPABASE_URL` = `https://uosswtbajrjcegyaqwdb.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = la clave pública `anon` del proyecto (la misma de `.env.local`). Nunca uses `service_role`.
   - `VITE_VAPID_PUBLIC_KEY` = clave pública VAPID usada por el servicio push. Es pública y la aplicación la necesita al construir.
3. Despliega. Las variables `VITE_*` se incrustan al construir, así que después de cambiarlas hay que volver a desplegar.
4. En Supabase, **Authentication → URL Configuration**, define el dominio de producción como **Site URL** y agrégalo a **Redirect URLs** (`https://tu-dominio.vercel.app/**`). El inicio de sesión con correo y contraseña no necesita callback, pero esto evita bloqueos de seguridad y cubre futuros enlaces de recuperación.
5. Comprueba el dominio publicado: inicio de sesión, carga de pedidos, cajas, cobro dividido y una foto de menú.

No se requiere `vercel dev` ni un servidor Node: es un sitio estático que habla directo con Supabase.

### Cuentas, instalación y notificaciones push

Superadmin crea cada cuenta con una contraseña temporal generada desde Equipo. La persona debe elegir una contraseña propia en su primer ingreso. Luego puede cambiarla desde Tu cuenta → Seguridad. La contraseña temporal debe compartirse de forma privada.

La aplicación incluye un manifiesto PWA y un service worker para instalar Palatto desde el navegador. En Android/Chrome usa **Instalar aplicación**; en iPhone/iPad abre Compartir → **Añadir a pantalla de inicio**. La instalación requiere el dominio de producción por HTTPS.

Las notificaciones push avisan de pedidos nuevos a los demás usuarios activos que las habilitaron en ese dispositivo. Para completar su envío en producción:

1. Genera un par VAPID una sola vez con `npx web-push generate-vapid-keys` y conserva ambas claves. No vuelvas a generarlas después de que los usuarios se suscriban.
2. En **Vercel → Project → Settings → Environment Variables**, crea `VITE_VAPID_PUBLIC_KEY` con la clave pública para Production, Preview y Development; luego vuelve a desplegar. Los cambios de variables solo llegan a despliegues nuevos.
3. En **Supabase → Project Settings → Edge Functions → Secrets**, agrega `PALATTO_VAPID_PUBLIC_KEY` con esa misma clave pública, `PALATTO_VAPID_PRIVATE_KEY` con la clave privada y `PALATTO_VAPID_SUBJECT` con un contacto real, por ejemplo `mailto:tu-correo@dominio.com`. La clave privada se guarda solo en Supabase; nunca la pongas en Vercel ni en el frontend.
4. Inicia sesión en Palatto desde un navegador compatible, abre Tu cuenta → Notificaciones y pulsa **Activar notificaciones**. Cada dispositivo debe aceptar el permiso.

La migración y las funciones Edge `manage-users` y `palatto-push` ya están aplicadas al proyecto Supabase. Falta configurar el par VAPID y desplegar esta versión del frontend en Vercel para habilitar el flujo completo.



### Reportes y análisis de ventas
La pestaña **Reportes** calcula todo desde los pedidos cobrados, sin tablas nuevas. Incluye:

- Ventas del día, pedidos cobrados, ticket promedio y artículos vendidos.
- Filtros Hoy, Ayer, 7 días, Este mes y Todo.
- Separación por caja (Palatto y Aguas y colas) y por forma de pago.
- Ventas por hora con el pico destacado, productos más vendidos, ventas por categoría y tendencia de los últimos 14 días.
- Exportación CSV de las líneas vendidas en el rango elegido.

Las fechas y horas usan `America/Guayaquil`. Solo cuentan los pedidos con `paid = true`; un pedido pendiente no se muestra como venta. El inicio muestra un resumen de ventas de hoy con acceso directo a Reportes.

### Insumos e inventario
La pestaña **Insumos** permite registrar carne, papa, pan y cualquier otro recurso con su unidad, stock mínimo, costo y movimientos:

- **Entrada** suma stock (compras o reposiciones).
- **Consumo** resta stock y nunca permite dejarlo negativo.
- **Ajuste** fija el stock real de un conteo físico.
- Cada movimiento guarda cantidad, motivo, usuario y fecha. La lista resalta los insumos agotados o por debajo del mínimo y calcula el valor del inventario.

La migración `20261111120000_inventory.sql` crea las tablas `supplies` y `supply_movements`, sus permisos y las funciones `save_supply` y `register_supply_movement`. Está aplicada al proyecto remoto desde el 11 de noviembre de 2026 y verificada con `node --env-file=.env.local scripts/verify-connection.mjs` y una prueba transaccional de los RPC. `scripts/activate-inventory.sql` queda como versión idempotente para otro entorno.

Si las tablas no existen (por ejemplo, en un proyecto nuevo), la app detecta el caso y guarda el inventario en el navegador (`localStorage`), mostrando un aviso en pantalla. Los reportes no dependen de esta migración.

### Inicio, cajas y menú visual
El inicio muestra la caja principal como bloque principal, con su saldo, las ventas del día, una carita que evoluciona según lo vendido y los gastos del día al lado. Aguas y colas aparece como un acceso secundario y discreto. La pestaña Caja abre directamente la caja principal; desde ahí se entra a la caja de aguas y colas. No hay turnos. Solo Superadmin puede transferir entre cajas: requiere saldo suficiente en el medio seleccionado y motivo, y genera dos asientos vinculados en una transacción.

Las fotos se cargan desde Menú al crear o editar productos (JPG, PNG o WebP, hasta 5 MB). Las imágenes del menú son públicas; los comprobantes siguen siendo privados. El número mostrado en una orden nueva es provisional hasta que PostgreSQL asigna el definitivo al guardarla.

Actualización de interfaz: Nuevo permanece dentro de la navegación y solo se anima al pulsarlo. La orden usa formato de comprobante; seleccionar un producto regresa a la orden. Las tarjetas de caja muestran el saldo total y su desglose por medio. El reporte diario desglosa cobros, ingresos, gastos, retiros, correcciones y transferencias, con el neto por medio de pago, usando la fecha de Ecuador.

Los clientes pueden pagar en efectivo o transferencia. Cada caja registra su parte con el medio real del cobro, incluida la de aguas y colas. Una cuenta puede dividirse por persona con medios distintos. Esto es una clasificación contable, no una transferencia bancaria ni un movimiento físico automático.

### Tarifa para llevar
La migración `20260917160000_takeaway_fees.sql` añade `products.takeaway_fee` (centavos por unidad) y `orders.takeaway`. El editor de productos ofrece Sí/No y exige un importe positivo al activar la tarifa. La orden exige escoger Para servir o Para llevar antes de enviarse.

Los precios efectivos se calculan en PostgreSQL y se guardan junto con precio base y tarifa de cada línea. Las correcciones conservan esos precios históricos; cambiar a servir elimina el adicional y, si la orden ya estaba cobrada, genera el ajuste contable correspondiente. Las tarifas no modifican pedidos anteriores. Migración aplicada al proyecto remoto y registrada como 20260917160000_takeaway_fees. Columnas y funciones verificadas en Supabase.

### Un solo negocio y pagos divididos
La migración `20261111140000_single_business_split_payments.sql` está aplicada al proyecto remoto desde el 11 de noviembre de 2026. Reutiliza el valor interno `carreta` para la caja de aguas y colas, elimina la exigencia de turnos, separa gasto de retiro, permite transferencias en la caja de aguas y colas y crea `order_payments` con la función `add_split_payment`. Los pedidos históricos conservan sus movimientos y se normalizaron a los nuevos tipos de movimiento.

### Total ajustable al cobrar
La migración `20261112090000_order_total_adjustment.sql` está aplicada al proyecto remoto desde el 12 de noviembre de 2026. Agrega `orders.adjustment` y `orders.adjustment_reason`, y amplía `pay_order` con `p_total` y `p_reason`. Si el total final difiere del total de los productos, el motivo es obligatorio. Los movimientos se reparten de forma proporcional entre las cajas y el ajuste aparece en el detalle del pedido, en los reportes y en el CSV.

### Conexión MCP de OpenCode
El MCP remoto de Supabase está configurado con el `project_ref` de Palatto y autenticado por OAuth. El token se guarda en `~/.local/share/opencode/mcp-auth.json`, fuera del repositorio. La configuración solo contiene el `project_ref` y las funciones habilitadas.
