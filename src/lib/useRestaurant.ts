import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { canCash, canEdit, canMenu, canWrite, total, validatePayment } from './domain';
import type { Business, Data, Item, Method, MovementKind, Order, Product, Profile, Role } from './domain';
const empty: Data = { products: [], orders: [], shifts: [], movements: [], order_payments: [], profiles: [], audits: [] };
export function useRestaurant() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [data, setData] = useState<Data>(empty);
    const [loading, setLoading] = useState(!!supabase);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const refreshVersion = useRef(0);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const refresh = useCallback(async () => {
        if (!supabase)
            return;
        const version = ++refreshVersion.current;
        const { data: { user } } = await supabase.auth.getUser();
        if (version !== refreshVersion.current)
            return;
        if (!user) {
            setProfile(null);
            setData(empty);
            setLoading(false);
            return;
        }
        const results = await Promise.all(['profiles', 'products', 'orders', 'shifts', 'movements', 'order_payments', 'audits'].map(async (table) => {
            const rows: Record<string, unknown>[] = [];
            for (let offset = 0;; offset += 1000) {
                const { data: batch, error } = await supabase!.from(table).select('*').order('id').range(offset, offset + 999);
                if (error)
                    throw error;
                rows.push(...batch);
                if (batch.length < 1000)
                    break;
            }
            return rows;
        }));
        if (version !== refreshVersion.current)
            return;
        const [profiles, products, orders, shifts, movements, orderPayments, audits] = results;
        orders.sort((a, b) => Number(a.number) - Number(b.number));
        products.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const me = profiles.find(p => p.id === user.id) as Profile | undefined;
        if (!me || !me.active) {
            setProfile(null);
            setData(empty);
            throw new Error('Tu usuario no tiene un perfil activo. Solicita acceso al superadmin.');
        }
        setProfile(me);
        setData({ profiles, products, orders, shifts, movements, order_payments: orderPayments, audits } as unknown as Data);
        setLoading(false);
    }, []);
    useEffect(() => {
        if (!supabase)
            return;
        const load = () => { void refresh().catch(e => { setError(e.message); setLoading(false); }); };
        load();
        const { data: listener } = supabase.auth.onAuthStateChange(() => { setTimeout(load, 0); });
        const channel = supabase.channel('restaurant').on('postgres_changes', { event: '*', schema: 'public' }, load).subscribe();
        const timer = setInterval(load, 20000);
        return () => { listener.subscription.unsubscribe(); void supabase!.removeChannel(channel); clearInterval(timer); };
    }, [refresh]);
    useEffect(() => { if (notice) {
        const t = setTimeout(() => setNotice(''), 4500);
        return () => clearTimeout(t);
    } }, [notice]);
    async function run(action: () => Promise<void> | void, message: string | (() => string)) {
        if (lock.current)
            return false;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
            try {
                await refresh();
            } catch {
                setError('Guardado. No se pudo actualizar la pantalla; no repitas la operación.');
                setLoading(false);
            }
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
    }
    const role = profile?.role || 'visualizador';
    const id = () => crypto.randomUUID();
    function writer() { if (!canWrite(role))
        throw new Error('Este rol solo puede consultar.'); }
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
    return {
        data, profile, role, loading, busy, error, notice, setError, setNotice,
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
        }, 'Contraseña actualizada'),
        push: async (values: Record<string, unknown>) => {
            if (!supabase) throw new Error('No se pudo conectar con Supabase.');
            const { data: result, error } = await supabase.functions.invoke('palatto-push', { body: values });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
            return result;
        },
        saveOrder: (customer: string, notes: string, items: Item[], order?: Order, reason = '', received = 0, receipt: string | null = null, takeaway = false) => {
            let pushResult: { sent?: number; attempted?: number; reason?: string } | null = null;
            let pushFailed = false;
            return run(async () => {
                writer();
                checkItems(items, order?.items);
                if (!customer.trim())
                    throw new Error('Escribe la mesa o el nombre del cliente.');
                if (order && !canEdit(role, order))
                    throw new Error('No tienes permiso para editar este pedido.');
                if (order && reason.trim().length < 3)
                    throw new Error('Escribe el motivo de la corrección.');
                if (order?.paid && total(items) !== total(order.items))
                    validatePayment(total(items) - total(order.items), order.method!, received, receipt);
                const args = { p_takeaway: takeaway, p_customer: customer, p_notes: notes, p_items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })) };
                await rpc(order ? 'edit_order' : 'create_order', order ? { ...args, p_id: order.id, p_version: order.version, p_reason: reason, p_received: received, p_receipt: receipt } : args);
                if (!order && supabase) try {
                    const { data: result, error } = await supabase.functions.invoke('palatto-push', { body: { action: 'notify_new_order' } });
                    if (error || result?.error) throw error || new Error(result.error);
                    pushResult = result as typeof pushResult;
                } catch { pushFailed = true; /* Push delivery must not undo an order. */ }
            }, () => {
                if (order) return 'Pedido actualizado. Ajustes registrados por caja.';
                if (pushFailed) return 'Pedido creado, pero no se pudo enviar el aviso push.';
                if (!pushResult || (pushResult.sent || 0) === 0) {
                    if ((pushResult?.attempted || 0) > 0) return 'Pedido creado, pero el servicio rechazó el aviso. Revisa que las claves VAPID coincidan.';
                    return 'Pedido creado. Activa notificaciones en otro teléfono o cuenta para recibir avisos.';
                }
                return `Pedido creado. Aviso enviado a ${pushResult.sent} dispositivo${pushResult.sent === 1 ? '' : 's'}.`;
            });
        },

        pay: (order: Order, method: Method, received: number, receipt: string | null, amount = total(order.items), reason = '') => run(async () => {
            writer();
            if (order.paid) throw new Error('Este pedido ya está completado.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.');
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('El total debe ser un importe mayor a cero.');
            if (amount !== total(order.items) && reason.trim().length < 3) throw new Error('Explica el motivo del ajuste al total.');
            validatePayment(amount, method, received, receipt);
            await rpc('pay_order', { p_id: order.id, p_version: order.version, p_method: method, p_received: received, p_receipt: receipt, p_total: amount, p_reason: reason.trim() || null });
        }, 'Pedido completado. Pago registrado en las cajas.'),
        splitPay: (order: Order, label: string, items: Item[], method: Method, received: number, receipt: string | null) => run(async () => {
            writer();
            if (order.paid) throw new Error('Este pedido ya está completado.');
            if (!items.length) throw new Error('Elige al menos un producto para esta persona.');
            const amount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
            validatePayment(amount, method, received, receipt);
            await rpc('add_split_payment', {
                p_id: order.id, p_version: order.version, p_label: label.trim(), p_items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
                p_method: method, p_received: received, p_receipt: receipt,
            });
        }, 'Pago de la persona registrado'),
        deleteOrder: (order: Order, reason: string) => run(async () => {
            writer();
            if (order.paid) throw new Error('Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('El pedido tiene pagos divididos y no puede eliminarse.');
            if (reason.trim().length < 3) throw new Error('Escribe el motivo de la eliminación.');
            await rpc('delete_order', { p_id: order.id, p_version: order.version, p_reason: reason.trim() });
        }, 'Pedido eliminado'),
        saveProduct: (product: Product) => run(async () => {
            if (/sorbete|frozz?en/i.test(product.name + ' ' + product.category)) product = { ...product, business: 'carreta' };
            if (!canMenu(role)) throw new Error('Solo administración puede editar el menú.');
            if (!product.name.trim() || !Number.isInteger(product.price) || product.price <= 0) throw new Error('Escribe un nombre y un precio mayor a cero.');
            await rpc('save_product', { p_id: product.id || null, p_name: product.name, p_price: product.price, p_business: product.business, p_category: product.category, p_active: product.active, p_image_path: product.image_path || null, p_takeaway_fee: product.takeaway_fee || 0 });
        }, 'Menú actualizado'),
        cash: (business: Business, amount: number, method: Method, reason: string, kind: MovementKind = 'ingreso') => run(async () => {
            if (!canCash(role, business)) throw new Error('No puedes ajustar esta caja.');
            if (!Number.isSafeInteger(amount) || amount === 0 || reason.trim().length < 3) throw new Error('Indica un importe válido y el motivo.');
            if (kind === 'ingreso' && amount < 0) throw new Error('El ingreso debe ser positivo.');
            if ((kind === 'gasto' || kind === 'retiro') && amount > 0) throw new Error('El gasto o retiro debe ser negativo.');
            await rpc('cash_movement', { p_business: business, p_amount: amount, p_method: method, p_reason: reason, p_kind: kind });
        }, 'Movimiento registrado'),
        transfer: (transferId: string, business: Business, amount: number, method: Method, reason: string) => run(async () => {
            await rpc('transfer_cash', { p_id: transferId, p_source: business, p_amount: amount, p_method: method, p_reason: reason });
        }, 'Transferencia registrada'),
        productPhotoUrl: (path: string) => supabase!.storage.from('menu-images').getPublicUrl(path).data.publicUrl,
        async uploadProductPhoto(file: File): Promise<string> {
            if (!canMenu(role)) throw new Error('Solo administración puede subir fotos.');
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Usa JPG, PNG o WebP de hasta 5 MB.');
            const path = profile!.id + '/' + id() + '.' + file.type.split('/')[1];
            const { error } = await supabase!.storage.from('menu-images').upload(path, file, { contentType: file.type });
            if (error) throw error;
            return path;
        },
        manageUser: (values: { name: string; email?: string; password?: string; role: Role; id?: string; active?: boolean }) => run(async () => {
            if (role !== 'superadmin') throw new Error('Solo el superadmin puede gestionar usuarios.');
            const { data: result, error } = await supabase!.functions.invoke('manage-users', { body: values });
            if (error) throw error;
            if (result?.error) throw new Error(result.error);
        }, 'Usuario guardado'),
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
            }, 'Contraseña temporal generada');
            return success ? credential : null;
        },
        async upload(file: File): Promise<string> {
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Usa una imagen JPG, PNG o WebP de hasta 5 MB.');
            const path = `${profile!.id}/${id()}.${file.type.split('/')[1]}`;
            const { error } = await supabase!.storage.from('receipts').upload(path, file, { contentType: file.type, upsert: false });
            if (error) throw error;
            return path;
        },
        async receiptUrl(path: string) {
            const { data, error } = await supabase!.storage.from('receipts').createSignedUrl(path, 120);
            if (error) throw error;
            return data.signedUrl;
        },
    };
}
export type Restaurant = ReturnType<typeof useRestaurant>;
