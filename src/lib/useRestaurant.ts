import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { canCash, canEdit, canMenu, canWrite, total, validatePayment } from './domain';
import type { Business, Data, Item, Method, MovementKind, Order, Product, Profile, Role } from './domain';
import { notifyActivity } from './push';
import type { PushActivity } from './push';
const empty: Data = { products: [], orders: [], shifts: [], movements: [], order_payments: [], profiles: [], audits: [] };
export function useRestaurant() {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [data, setData] = useState<Data>(empty);
    const [loading, setLoading] = useState(!!supabase);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const refreshVersion = useRef(0);
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
        orders.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.number) - Number(b.number));
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
    async function run(action: () => Promise<void> | void, message: string | (() => string), activity?: PushActivity) {
        if (lock.current)
            return false;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
            if (activity) void notifyActivity(activity);
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
        return result.data;
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
        saveOrder: async (customer: string, notes: string, items: Item[], order?: Order, reason = '', received = 0, receipt: string | null = null, takeaway = false) => {
            let savedId = order?.id || '';
            const ok = await run(async () => {
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
                    await rpc('edit_order', { ...args, p_id: order.id, p_version: order.version, p_reason: reason, p_received: received, p_receipt: receipt });
                } else {
                    savedId = String(await rpc('create_order', args));
                }
            }, order ? 'Pedido actualizado. Ajustes registrados por caja.' : 'Pedido enviado a la cola', order ? 'order_updated' : 'order_created');
            return ok ? savedId : null;
        },

        pay: (order: Order, method: Method, received: number, receipt: string | null, amount = total(order.items)) => run(async () => {
            writer();
            if (order.paid) throw new Error('Este pedido ya está completado.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('Este pedido tiene pagos divididos. Cobra el resto desde Dividir cuenta.');
            if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('El total debe ser un importe mayor a cero.');
            validatePayment(amount, method, received, receipt);
            await rpc('pay_order', { p_id: order.id, p_version: order.version, p_method: method, p_received: received, p_receipt: receipt, p_total: amount });
        }, 'Pedido completado. Pago registrado en la caja.', 'order_paid'),
        splitPay: (order: Order, label: string, items: Item[], method: Method, received: number, receipt: string | null) => run(async () => {
            writer();
            if (order.paid) throw new Error('Este pedido ya está completado.');
            if (!items.length) throw new Error('Elige al menos un producto para esta persona.');
            const amount = items.reduce((sum, item) => sum + Math.round((item.price * item.quantity + (item.takeaway_fee || 0) * (item.takeaway_quantity || 0)) / item.quantity) * item.quantity, 0);
            validatePayment(amount, method, received, receipt);
            await rpc('add_split_payment', {
                p_id: order.id, p_version: order.version, p_label: label.trim(), p_items: items.map(i => ({ product_id: i.product_id, quantity: i.quantity })),
                p_method: method, p_received: received, p_receipt: receipt,
            });
        }, 'Pago de la persona registrado', 'split_payment'),
        deleteOrder: (order: Order, reason: string) => run(async () => {
            writer();
            if (order.paid) throw new Error('Un pedido cobrado no se elimina. Corrígelo o registra el movimiento en caja.');
            if (data.order_payments.some(payment => payment.order_id === order.id)) throw new Error('El pedido tiene pagos divididos y no puede eliminarse.');
            if (reason.trim().length < 3) throw new Error('Escribe el motivo de la eliminación.');
            await rpc('delete_order', { p_id: order.id, p_version: order.version, p_reason: reason.trim() });
        }, 'Pedido eliminado', 'order_deleted'),
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
            });
        }, 'Menú actualizado', 'product_saved'),
        deleteProduct: (product: Product) => run(async () => {
            if (!canMenu(role)) throw new Error('Solo administración puede eliminar productos.');
            if (!product.id) throw new Error('El producto ya no existe.');
            await rpc('delete_product', { p_id: product.id });
        }, 'Producto eliminado del menú', 'product_saved'),
        cash: (business: Business, amount: number, method: Method, reason: string, kind: MovementKind = 'ingreso', receipt: string | null = null) => run(async () => {
            if (!canCash(role, business)) throw new Error('No puedes ajustar esta caja.');
            if (!Number.isSafeInteger(amount) || amount === 0 || reason.trim().length < 3) throw new Error('Indica un importe válido y el motivo.');
            if (kind === 'ingreso' && amount < 0) throw new Error('El ingreso debe ser positivo.');
            if ((kind === 'gasto' || kind === 'retiro') && amount > 0) throw new Error('El gasto o retiro debe ser negativo.');
            await rpc('cash_movement', { p_business: business, p_amount: amount, p_method: method, p_reason: reason, p_kind: kind, p_receipt: receipt });
        }, 'Movimiento registrado', 'cash_movement'),
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
        }, 'Usuario guardado', 'user_saved'),
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
