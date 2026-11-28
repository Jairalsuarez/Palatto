import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { canCash, canEdit, canMenu, canTakeOrders, total, validatePayment } from './domain';
import type { Business, Data, Item, Method, MovementKind, Order, Product, Profile, Role } from './domain';
import { notifyActivity } from './push';
import type { PushActivity, PushDetails } from './push';
import { compressReceiptImage, triggerBlobDownload } from './receipts';
const empty: Data = { products: [], orders: [], shifts: [], movements: [], order_payments: [], profiles: [], audits: [], settings: [], notifications: [] };
export function useRestaurant() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [data, setData] = useState<Data>(empty);
    const [loading, setLoading] = useState(!!supabase);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const refreshVersion = useRef(0);
    const receiptCache = useRef(new Map<string, { url: string; expires: number }>());
    const receiptUrlInflight = useRef(new Map<string, Promise<string>>());
    const receiptBlobCache = useRef(new Map<string, { blob: Blob; objectUrl: string }>());
    const receiptBlobInflight = useRef(new Map<string, Promise<{ blob: Blob; objectUrl: string }>>());
    const [error, setError] = useState('');
    const [notices, setNotices] = useState<{ id: string; message: string }[]>([]);
    const notice = notices.at(-1)?.message || '';
    const setNotice = useCallback((message: string) => {
        if (!message) {
            setNotices([]);
            return;
        }
        const id = crypto.randomUUID();
        setNotices(current => [...current, { id, message }]);
        setTimeout(() => setNotices(current => current.filter(item => item.id !== id)), 4800);
    }, []);
    const dismissNotice = useCallback((id: string) => {
        setNotices(current => current.filter(item => item.id !== id));
    }, []);
    const refresh = useCallback(async () => {
        if (!supabase)
            return;
        const version = ++refreshVersion.current;
        const { data: { session } } = await supabase.auth.getSession();
        const user = session?.user;
        if (version !== refreshVersion.current)
            return;
        if (!user) {
            setProfile(null);
            setData(empty);
            setLoading(false);
            return;
        }
        async function loadRows(table: string, optional = false, orderColumn = 'id') {
            const rows: Record<string, unknown>[] = [];
            try {
                for (let offset = 0;; offset += 1000) {
                    const { data: batch, error } = await supabase!.from(table).select('*').order(orderColumn).range(offset, offset + 999);
                    if (error)
                        throw error;
                    rows.push(...batch);
                    if (batch.length < 1000)
                        break;
                }
            }
            catch (error) {
                if (!optional)
                    throw error;
            }
            return rows;
        }
        async function loadRecentNotifications() {
            try {
                const { data: rows, error } = await supabase!.from('notifications').select('*').order('created_at', { ascending: false }).limit(300);
                if (error)
                    throw error;
                return rows;
            }
            catch {
                return [];
            }
        }
        const [results, optionalRows] = await Promise.all([
            Promise.all(['profiles', 'products', 'orders', 'shifts', 'movements', 'order_payments', 'audits'].map(table => loadRows(table))),
            Promise.all([loadRows('app_settings', true, 'key'), loadRecentNotifications()]),
        ]);
        if (version !== refreshVersion.current)
            return;
        const [profiles, products, orders, shifts, movements, orderPayments, audits] = results;
        const [settings, notifications] = optionalRows;
        orders.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.number) - Number(b.number));
        products.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        notifications.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const me = profiles.find(p => p.id === user.id) as Profile | undefined;
        if (!me || !me.active) {
            setProfile(null);
            setData(empty);
            throw new Error('Tu usuario no tiene un perfil activo. Solicita acceso al superadmin.');
        }
        setProfile(me);
        setData({ profiles, products, orders, shifts, movements, order_payments: orderPayments, audits, settings, notifications: notifications.slice(0, 300) } as unknown as Data);
        setLoading(false);
    }, []);
    useEffect(() => {
        if (!supabase)
            return;
        const load = () => { void refresh().catch(e => { setError(e.message); setLoading(false); }); };
        let realtimeTimer: number | undefined;
        const scheduleLoad = () => {
            window.clearTimeout(realtimeTimer);
            realtimeTimer = window.setTimeout(load, 400);
        };
        load();
        const { data: listener } = supabase.auth.onAuthStateChange(() => { setTimeout(load, 0); });
        const channel = supabase.channel('restaurant').on('postgres_changes', { event: '*', schema: 'public' }, scheduleLoad).subscribe();
        const timer = setInterval(load, 30000);
        return () => { listener.subscription.unsubscribe(); void supabase!.removeChannel(channel); clearInterval(timer); window.clearTimeout(realtimeTimer); };
    }, [refresh]);
    async function run(action: () => Promise<void> | void, message: string | (() => string), activity?: PushActivity | (() => { event: PushActivity; details?: PushDetails }), waitForRefresh = false) {
        if (lock.current)
            return false;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
            let orderCreated = false;
            if (activity) {
                try {
                    const resolved = typeof activity === 'function' ? activity() : { event: activity, details: undefined };
                    orderCreated = resolved.event === 'order_created';
                    if (orderCreated) {
                        void notifyActivity(resolved.event, resolved.details).then(result => {
                            if (!result || result.sent > 0) return;
                            const reason = result.reason;
                            const detail = reason === 'push_not_configured'
                                ? 'Faltan las claves VAPID en Supabase.'
                                : reason === 'no_subscriptions'
                                    ? 'El cocinero debe activar notificaciones en su dispositivo.'
                                    : reason === 'no_recipients'
                                        ? 'No hay cuentas activas con rol Cocinero.'
                                        : reason === 'internal_only'
                                            ? 'Este pedido no contiene productos de cocina.'
                                            : reason === 'network_error' || reason === 'function_error'
                                                ? 'El servidor de notificaciones no respondió correctamente.'
                                            : 'Revisa la conexión y la configuración push de Supabase.';
                            setNotice(`Pedido guardado, pero no se envió el aviso push. ${detail}`);
                        });
                    } else {
                        void notifyActivity(resolved.event, resolved.details);
                    }
                }
                catch { /* la notificación nunca debe bloquear la operación */ }
            }
            // The RPC is the source of truth. Start a full sync without making
            // the payment/movement UI wait for every table to load.
            const sync = refresh().catch(() => {
                setError('Guardado. La pantalla se actualizará en unos segundos; no repitas la operación.');
                setLoading(false);
            });
            if (waitForRefresh) await sync;
            setNotice(typeof message === 'function' ? message() : message);
            return true;
        }
        catch (e) {
            setError(e instanceof Error ? e.message : (e as {
                message?: string;
            }).message || 'No se pudo guardar. Inténtalo de nuevo.');
            return false;
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    async function rpc(name: string, args: Record<string, unknown>) {
        let result = await supabase!.rpc(name, args);
        if (result.error?.code === 'PGRST202' && ('p_takeaway' in args || 'p_takeaway_fee' in args)) {
            if (args.p_takeaway || args.p_takeaway_fee)
                throw new Error('Falta activar las tarifas para llevar en Supabase. Los cambios no se han guardado.');
            const legacyArgs = { ...args };
            delete legacyArgs.p_takeaway;
            delete legacyArgs.p_takeaway_fee;
            result = await supabase!.rpc(name, legacyArgs);
        }
        if (result.error) throw result.error;
        return result.data;
    }
    const role = profile?.role || 'visualizador';
    const id = () => crypto.randomUUID();
    function orderWriter() { if (!canTakeOrders(role))
        throw new Error('Este rol no puede gestionar pedidos.'); }
    function checkItems(items: Item[], previous: Item[] = []) {
        if (!items.length)
            throw new Error('Añade al menos un producto.');
        for (const i of items) {
            if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99)
                throw new Error('La cantidad debe estar entre 1 y 99.');
            const old = previous.find(p => p.product_id === i.product_id);
            if ((!old || i.quantity > old.quantity) && !data.products.find(p => p.id === i.product_id)?.active)
                throw new Error('El producto ya no está disponible.');
        }
    }
    const getSignedReceiptUrl = useCallback(async (path: string): Promise<string> => {
        const cached = receiptCache.current.get(path);
        if (cached && cached.expires > Date.now() + 30_000) return cached.url;
        const pending = receiptUrlInflight.current.get(path);
        if (pending) return pending;
        const request = (async () => {
            const { data, error } = await supabase!.storage.from('receipts').createSignedUrl(path, 3600);
            if (error) throw error;
            receiptCache.current.set(path, { url: data.signedUrl, expires: Date.now() + 3600_000 });
            return data.signedUrl;
        })();
        receiptUrlInflight.current.set(path, request);
        try {
            return await request;
        } finally {
            receiptUrlInflight.current.delete(path);
        }
    }, []);
    const loadReceiptBlob = useCallback(async (path: string): Promise<{ blob: Blob; objectUrl: string }> => {
        const cached = receiptBlobCache.current.get(path);
        if (cached) return cached;
        const pending = receiptBlobInflight.current.get(path);
        if (pending) return pending;
        const request = (async () => {
            const signedUrl = await getSignedReceiptUrl(path);
            const response = await fetch(signedUrl);
            if (!response.ok) throw new Error('No se pudo cargar la foto.');
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            if (receiptBlobCache.current.size >= 40) {
                const oldestKey = receiptBlobCache.current.keys().next().value;
                if (oldestKey) {
                    const oldest = receiptBlobCache.current.get(oldestKey);
                    if (oldest) URL.revokeObjectURL(oldest.objectUrl);
                    receiptBlobCache.current.delete(oldestKey);
                }
            }
            const entry = { blob, objectUrl };
            receiptBlobCache.current.set(path, entry);
            return entry;
        })();
        receiptBlobInflight.current.set(path, request);
        try {
            return await request;
        } finally {
            receiptBlobInflight.current.delete(path);
        }
    }, [getSignedReceiptUrl]);
    const peekReceiptObjectUrl = useCallback((path: string): string | null => {
        return receiptBlobCache.current.get(path)?.objectUrl || null;
    }, []);
    const peekReceiptUrl = useCallback((path: string): string | null => {
        const cachedBlob = receiptBlobCache.current.get(path);
        if (cachedBlob) return cachedBlob.objectUrl;
        const cached = receiptCache.current.get(path);
        return cached && cached.expires > Date.now() + 30_000 ? cached.url : null;
    }, []);
    const prefetchReceipts = useCallback(async (paths: string[]) => {
        if (!supabase) return;
        const unique = Array.from(new Set(paths.filter(Boolean)));
        if (!unique.length) return;
        const now = Date.now();
        const missingUrls = unique.filter(path => {
            const cached = receiptCache.current.get(path);
            return !cached || cached.expires <= now + 30_000;
        });
        if (missingUrls.length) {
            try {
                const { data: signedList, error } = await supabase.storage.from('receipts').createSignedUrls(missingUrls, 3600);
                if (!error && signedList) {
                    for (const entry of signedList) {
                        if (entry.path && entry.signedUrl) {
                            receiptCache.current.set(entry.path, { url: entry.signedUrl, expires: Date.now() + 3600_000 });
                        }
                    }
                }
            } catch {
                // Ignore background prefetch failures; on-demand fetch handles retries.
            }
        }
        // Warm up the first 8 images in memory so tapping them is instantaneous.
        for (const path of unique.slice(0, 8)) {
            if (receiptBlobCache.current.has(path) || receiptBlobInflight.current.has(path)) continue;
            void loadReceiptBlob(path).catch(() => undefined);
        }
    }, [loadReceiptBlob]);
    const receiptDisplayUrl = useCallback(async (path: string): Promise<{ displayUrl: string; externalUrl: string }> => {
        const externalUrl = await getSignedReceiptUrl(path);
        try {
            const { objectUrl } = await loadReceiptBlob(path);
            return { displayUrl: objectUrl, externalUrl };
        } catch {
            return { displayUrl: externalUrl, externalUrl };
        }
    }, [getSignedReceiptUrl, loadReceiptBlob]);
    const downloadReceipt = useCallback(async (path: string, filename: string) => {
        try {
            const { blob } = await loadReceiptBlob(path);
            triggerBlobDownload(blob, filename);
        } catch {
            const signedUrl = await getSignedReceiptUrl(path);
            const link = document.createElement('a');
            link.href = signedUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
    }, [getSignedReceiptUrl, loadReceiptBlob]);
    useEffect(() => {
        const blobs = receiptBlobCache.current;
        return () => {
            for (const entry of blobs.values()) URL.revokeObjectURL(entry.objectUrl);
            blobs.clear();
        };
    }, []);
    return {
        data, profile, role, loading, busy, error, notice, notices, setError, setNotice, dismissNotice,
        login: (email: string, password: string) => run(async () => { if (!supabase)
            throw new Error('No se pudo conectar. Contacta al administrador.'); const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password }); if (error)
            throw error; }, 'Sesión iniciada'),
        logout: () => run(async () => { if (supabase) {
            const { error } = await supabase.auth.signOut();
            if (error)
                throw error;
        } setProfile(null); setData(empty); }, ''),
        changePassword: (password: string) => run(async () => {
            if (!supabase || password.length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres.');
            const { data: result, error } = await supabase.functions.invoke('manage-users', { body: { action: 'change_password', password } });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
        }, 'Contraseña actualizada', 'password_changed'),
        push: async (values: Record<string, unknown>) => {
            if (!supabase) throw new Error('No se pudo conectar con Supabase.');
            const { data: result, error } = await supabase.functions.invoke('palatto-push', { body: values });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
            return result;
        },
        acceptKitchenOrder: (order: Order, minutes: number) => run(async () => {
            if (role !== 'cocinero') throw new Error('Solo cocina puede aceptar pedidos.');
            await rpc('kitchen_accept_order', { p_id: order.id, p_version: order.version, p_prep_minutes: minutes });
        }, 'Pedido aceptado. El temporizador está en marcha.', undefined, true),
        rejectKitchenOrder: (order: Order) => run(async () => {
            if (role !== 'cocinero') throw new Error('Solo cocina puede rechazar solicitudes.');
            await rpc('kitchen_reject_order', { p_id: order.id, p_version: order.version });
        }, 'Pedido rechazado y cancelado por cocina.', () => ({
            event: 'order_deleted',
            details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer, reason: 'Rechazado y cancelado por cocina' },
        }), true),
        advanceKitchenOrder: (order: Order) => run(async () => {
            if (role !== 'cocinero') throw new Error('Solo cocina puede finalizar pedidos.');
            await rpc('kitchen_advance_order', { p_id: order.id, p_version: order.version });
        }, 'Pedido marcado como listo.'),
        kitchenEstimate: async (order: Order): Promise<number> => {
            if (role !== 'cocinero') throw new Error('Solo cocina puede consultar la estimación.');
            const result = await rpc('kitchen_estimate_minutes', { p_id: order.id });
            return Number(result);
        },
        saveOrder: async (customer: string, notes: string, items: Item[], order?: Order, takeaway = false, prepMinutes?: number, askKitchen = false, requirePickupCode = false) => {
            let savedId = order?.id || '';
            let updatedOrder: Order | null = null;
            const ok = await run(async () => {
                orderWriter();
                checkItems(items, order?.items);
                if (!customer.trim())
                    throw new Error('Escribe la mesa o el nombre del cliente.');
                if (order && !canEdit(role, order))
                    throw new Error('No tienes permiso para editar este pedido.');
                const args = {
                    p_takeaway: takeaway,
                    p_customer: customer,
                    p_notes: notes,
                    p_items: items.map(i => ({
                        product_id: i.product_id,
                        quantity: i.quantity,
                        takeaway_quantity: i.takeaway_quantity || 0,
                        is_drink: Boolean(i.is_drink),
                    })),
                };
                if (order) {
                    await rpc('edit_order', { ...args, p_id: order.id, p_version: order.version });
                    const { data: refreshed, error } = await supabase!.from('orders').select('*').eq('id', order.id).single();
                    if (error) throw error;
                    updatedOrder = refreshed as Order;
                } else {
                    savedId = String(await rpc('create_order_with_pickup_code', { ...args, p_prep_minutes: prepMinutes ?? null, p_ask_kitchen: askKitchen, p_require_pickup_code: requirePickupCode }));
                }
            }, order ? 'Pedido actualizado' : 'Pedido puesto en cola', () => ({
                event: order ? 'order_updated' : 'order_created',
                details: {
                    actorName: profile?.name,
                    orderId: savedId,
                    orderNumber: order?.number,
                    customer,
                    takeaway: takeaway || items.some(item => (item.takeaway_quantity || 0) > 0),
                    items: items.reduce((sum, item) => sum + item.quantity, 0),
                    itemsSummary: items.map(item => `${item.quantity} × ${item.name}`).join(', '),
                    amount: total(items),
                },
            }), askKitchen);
            if (ok && order && !updatedOrder) {
                const latest = data.orders.find(item => item.id === order.id);
                if (latest) updatedOrder = latest;
            }
            if (ok && order && updatedOrder) return updatedOrder;
            return ok ? savedId : null;
        },

        pay: (order: Order, method: Method, received: number, receipt: string | null, amount = total(order.items)) => run(async () => {
            orderWriter();
            if (order.paid) throw new Error('Este pedido ya está completado.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.');
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('El total debe ser un importe mayor a cero.');
            validatePayment(amount, method, received, receipt);
            await rpc('pay_order', { p_id: order.id, p_version: order.version, p_method: method, p_received: received, p_receipt: receipt, p_total: amount });
        }, 'Pedido completado. Pago registrado en la caja.', () => ({
            event: 'order_paid',
            details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer, amount, method },
        })),
        collectOrder: (order: Order, cashAmount: number, transferAmount: number, received: number, receipt: string | null, amount: number, deliver: boolean) => run(async () => {
            orderWriter();
            if (order.paid) throw new Error('Este pedido ya está cobrado.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.');
            if (cashAmount < 0 || transferAmount < 0 || cashAmount + transferAmount !== amount) throw new Error('El efectivo y la transferencia deben sumar el total.');
            if (cashAmount > 0 && (!Number.isSafeInteger(received) || received < cashAmount)) throw new Error('El efectivo recibido no cubre su parte.');
            if (transferAmount > 0 && !receipt) throw new Error('Sube la foto del comprobante de transferencia.');
            await rpc('collect_order', { p_id: order.id, p_version: order.version, p_cash_amount: cashAmount, p_transfer_amount: transferAmount, p_cash_received: received, p_transfer_receipt: receipt, p_total: amount, p_deliver: deliver });
        }, 'Cobro registrado en caja.', () => ({ event: 'order_paid', details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer, amount, method: cashAmount > 0 && transferAmount > 0 ? 'efectivo + transferencia' : cashAmount > 0 ? 'efectivo' : 'transferencia', delivered: deliver } })),
        deliverOrder: (order: Order) => run(async () => {
            orderWriter();
            if (!order.paid) throw new Error('Cobra el pedido antes de marcarlo como entregado.');
            if (order.delivered_at) throw new Error('El pedido ya fue entregado.');
            await rpc('deliver_order', { p_id: order.id, p_version: order.version });
        }, 'Pedido marcado como entregado.', () => ({ event: 'order_delivered', details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer } })),
        saveProfilePhoto: async (file: File) => {
            if (!supabase || !profile) throw new Error('Inicia sesión para cambiar tu foto.');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('Elige una foto JPG, PNG o WebP de hasta 2 MB.');
            const path = `${profile.id}/${crypto.randomUUID()}.${file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'}`;
            const { error: uploadError } = await supabase.storage.from('profile-photos').upload(path, file, { upsert: false, contentType: file.type });
            if (uploadError) throw uploadError;
            const { error: saveError } = await supabase.rpc('save_profile_avatar', { p_path: path });
            if (saveError) throw saveError;
            await refresh();
        },
        profilePhotoUrl: (path: string | null | undefined) => path && supabase ? supabase.storage.from('profile-photos').getPublicUrl(path).data.publicUrl : '',
        splitPay: (order: Order, label: string, items: Item[], method: Method, received: number, receipt: string | null) => {
            const amount = items.reduce((sum, item) => sum + item.price * item.quantity + (item.takeaway_fee || 0) * (item.takeaway_quantity || 0), 0);
            return run(async () => {
                orderWriter();
                if (order.paid) throw new Error('Este pedido ya está completado.');
                if (!items.length) throw new Error('Elige al menos un producto para esta persona.');
                validatePayment(amount, method, received, receipt);
                await rpc('add_split_payment', {
                    p_id: order.id, p_version: order.version, p_label: label.trim(), p_items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
                    p_method: method, p_received: received, p_receipt: receipt,
                });
            }, 'Pago de la persona registrado', () => ({
                event: 'split_payment',
                details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer, amount, method, label: label.trim() },
            }));
        },
        deleteOrder: (order: Order, reason: string) => run(async () => {
            orderWriter();
            if (order.paid) throw new Error('Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('El pedido tiene pagos divididos y no puede eliminarse.');
            if (reason.trim().length < 3) throw new Error('Escribe el motivo de la eliminación.');
            await rpc('delete_order', { p_id: order.id, p_version: order.version, p_reason: reason.trim() });
        }, 'Pedido eliminado', () => ({
            event: 'order_deleted',
            details: { actorName: profile?.name, orderId: order.id, orderNumber: order.number, customer: order.customer, reason: reason.trim() },
        })),
        saveProduct: (product: Product) => run(async () => {
            if (!canMenu(role)) throw new Error('Solo administración puede editar el menú.');
            if (!product.name.trim() || !Number.isInteger(product.price) || product.price <= 0) throw new Error('Escribe un nombre y un precio mayor a cero.');
            await rpc('save_product', {
                p_id: product.id || null,
                p_name: product.name,
                p_price: product.price,
                p_active: product.active,
                p_is_drink: Boolean(product.is_drink),
                p_image_path: product.image_path || null,
                p_takeaway_fee: product.takeaway_fee || 0,
                p_prep_minutes: product.prep_minutes || 10,
            });
        }, 'Menú actualizado', () => ({ event: 'product_saved', details: { actorName: profile?.name, name: product.name } })),
        deleteProduct: (product: Product) => run(async () => {
            if (!canMenu(role)) throw new Error('Solo administración puede eliminar productos.');
            if (!product.id) throw new Error('El producto ya no existe.');
            await rpc('delete_product', { p_id: product.id });
        }, 'Producto eliminado del menú', () => ({ event: 'product_saved', details: { actorName: profile?.name, name: product.name, reason: 'eliminado' } })),
        cash: (business: Business, amount: number, method: Method, reason: string, kind: MovementKind = 'ingreso', receipt: string | null = null) => {
            let movementId: string | null = null;
            return run(async () => {
                if (!canCash(role, business)) throw new Error('No puedes ajustar esta caja.');
                if (!Number.isSafeInteger(amount) || amount === 0 || reason.trim().length < 3) throw new Error('Indica un importe válido y el motivo.');
                if (kind === 'ingreso' && amount < 0) throw new Error('El ingreso debe ser positivo.');
                if ((kind === 'gasto' || kind === 'retiro') && amount > 0) throw new Error('El gasto o retiro debe ser negativo.');
                const result = await rpc('cash_movement', { p_business: business, p_amount: amount, p_method: method, p_reason: reason, p_kind: kind, p_receipt: receipt });
                movementId = typeof result === 'string' ? result : null;
            }, 'Movimiento registrado', () => ({
                event: 'cash_movement',
                details: { actorName: profile?.name, movementId: movementId || undefined, amount, method, kind, reason: reason.trim() },
            }));
        },
        reconcileCash: (business: Business, countedCash: number, countedTransfer: number) => {
            let reconciliation: { id: string; cash_balance: number; transfer_balance: number } | null = null;
            return run(async () => {
                if (!canCash(role, business) || business !== 'palatto') throw new Error('No puedes cuadrar esta caja.');
                if (!Number.isSafeInteger(countedCash) || countedCash < 0 || !Number.isSafeInteger(countedTransfer) || countedTransfer < 0) throw new Error('Ingresa saldos contados válidos.');
                const { data: result, error } = await supabase!.rpc('reconcile_cash', { p_id: crypto.randomUUID(), p_counted_cash: countedCash, p_counted_transfer: countedTransfer });
                if (error) throw error;
                if (!result || typeof result.id !== 'string') throw new Error('No se recibió el registro de cuadre. Actualiza la pantalla.');
                reconciliation = result as { id: string; cash_balance: number; transfer_balance: number };
            }, 'Caja cuadrada', () => ({
                event: 'cash_reconciled',
                details: {
                    actorName: profile?.name,
                    reconciliationId: reconciliation?.id,
                    cashBalance: reconciliation?.cash_balance,
                    transferBalance: reconciliation?.transfer_balance,
                    countedCash,
                    countedTransfer,
                },
            }));
        },
        productPhotoUrl: (path: string) => supabase!.storage.from('menu-images').getPublicUrl(path).data.publicUrl,
        async uploadProductPhoto(file: File): Promise<string> {
            if (!canMenu(role)) throw new Error('Solo administración puede subir fotos.');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Usa JPG, PNG o WebP de hasta 5 MB.');
            const path = profile!.id + '/' + id() + '.' + file.type.split('/')[1];
            const { error } = await supabase!.storage.from('menu-images').upload(path, file, { contentType: file.type });
            if (error) throw error;
            void notifyActivity('product_photo_saved');
            return path;
        },
        manageUser: (values: { name: string; email?: string; password?: string; role: Role; id?: string; active?: boolean }) => run(async () => {
            if (role !== 'superadmin') throw new Error('Solo el superadmin puede gestionar usuarios.');
            const { data: result, error } = await supabase!.functions.invoke('manage-users', { body: values });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
        }, 'Usuario guardado', () => ({
            event: 'user_saved',
            details: { actorName: profile?.name, name: values.name, reason: values.id ? (values.active === false ? 'desactivado' : 'actualizado') : 'creado' },
        })),
        getManagedUsers: async (): Promise<{ id: string; email: string }[]> => {
            if (role !== 'superadmin') throw new Error('Solo el superadmin puede ver las cuentas del equipo.');
            const { data: result, error } = await supabase!.functions.invoke('manage-users', { body: { action: 'list_users' } });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
            return result?.users || [];
        },
        resetUserPassword: async (userId: string): Promise<{ email: string; temporaryPassword: string } | null> => {
            if (role !== 'superadmin') { setError('Solo el superadmin puede generar contraseñas temporales.'); return null; }
            let credential: { email: string; temporaryPassword: string } | null = null;
            const success = await run(async () => {
                const { data: result, error } = await supabase!.functions.invoke('manage-users', { body: { action: 'reset_password', id: userId } });
                if (error) throw error;
                if (result?.error) throw new Error(result.error);
                credential = { email: result.email, temporaryPassword: result.temporaryPassword };
            }, 'Contraseña temporal generada', 'password_reset');
            return success ? credential : null;
        },
        setSetting: async (key: string, value: string) => {
            if (role !== 'superadmin' && role !== 'administrador') throw new Error('Solo administración puede cambiar la configuración.');
            const saved = await run(async () => {
                await rpc('set_app_setting', { p_key: key, p_value: value });
            }, 'Conteo reiniciado');
            if (saved) {
                setData(current => ({
                    ...current,
                    settings: [...current.settings.filter(setting => setting.key !== key), { key, value, updated_at: new Date().toISOString() }],
                }));
            }
            return saved;
        },
        async upload(file: File): Promise<string> {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Usa una imagen JPG, PNG o WebP de hasta 5 MB.');
            const prepared = await compressReceiptImage(file);
            const ext = prepared.type.split('/')[1] || 'jpg';
            const path = `${profile!.id}/${id()}.${ext}`;
            const { error } = await supabase!.storage.from('receipts').upload(path, prepared, { contentType: prepared.type, cacheControl: '31536000', upsert: false });
            if (error) throw error;
            // Pre-populate local blob cache immediately so the uploader can preview/download with zero delay.
            const objectUrl = URL.createObjectURL(prepared);
            receiptBlobCache.current.set(path, { blob: prepared, objectUrl });
            return path;
        },
        receiptUrl: getSignedReceiptUrl,
        peekReceiptUrl,
        peekReceiptObjectUrl,
        prefetchReceipts,
        receiptDisplayUrl,
        downloadReceipt,
    };
}
export type Restaurant = ReturnType<typeof useRestaurant>;
