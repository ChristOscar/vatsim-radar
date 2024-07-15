import { useStore } from '~/store';

async function decompressBlob(blob: Blob) {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = blob.stream().pipeThrough(ds);
    return await new Response(decompressedStream).blob();
}

export function initDataWebsocket(): () => void {
    const dataStore = useDataStore();

    const url = import.meta.dev ? `ws://${ location.hostname }:8880` : `wss://${ location.hostname }/ws`;
    const websocket = new WebSocket(url);

    websocket.addEventListener('open', () => {
        console.info('WebSocket was opened');
    });

    websocket.addEventListener('close', () => {
        console.info('WebSocket was closed');
    });
    websocket.addEventListener('error', console.error);

    websocket.addEventListener('message', async event => {
        if (localStorage.getItem('radar-socket-closed')) {
            localStorage.removeItem('radar-socket-closed');
            localStorage.removeItem('radar-socket-date');
            websocket.close();
            return;
        }

        const data = await (await decompressBlob(event.data as Blob)).text();
        localStorage.setItem('radar-socket-vat-data', data);
        localStorage.setItem('radar-socket-date', Date.now().toString());

        setVatsimDataStore(JSON.parse(data));
        dataStore.vatsim.data.general.value!.update_timestamp = new Date().toISOString();
        dataStore.vatsim.updateTimestamp.value = new Date().toISOString();
    });

    return () => websocket.close();
}

export function checkForWSData(isMounted: Ref<boolean>): () => void {
    const store = useStore();
    const dataStore = useDataStore();

    let closeSocket: (() => void) | undefined;

    function checkForSocket() {
        if (store.localSettings.traffic?.disableFastUpdate) return;
        const date = Date.now();
        const socketDate = localStorage.getItem('radar-socket-date');
        // 10 seconds gap for receiving date
        if (!socketDate || +socketDate + (1000 * 10) < date) {
            localStorage.setItem('radar-socket-date', Date.now().toString());
            closeSocket = initDataWebsocket();
        }
    }

    checkForSocket();
    const interval = setInterval(checkForSocket, 5000);

    function storageEvent() {
        const data = localStorage.getItem('radar-socket-vat-data');
        if (!data || !dataStore.vatsim.data.general.value) return;

        const json = JSON.parse(data);
        setVatsimDataStore(json);
        dataStore.vatsim.data.general.value!.update_timestamp = new Date().toISOString();
        dataStore.vatsim.updateTimestamp.value = new Date().toISOString();
    }

    window.addEventListener('storage', storageEvent);
    onBeforeUnmount(() => {
        clearInterval(interval);
        window.removeEventListener('storage', storageEvent);
    });

    watch(isMounted, () => {
        closeSocket?.();
        localStorage.setItem('radar-socket-closed', '1');
        localStorage.removeItem('radar-socket-date');
        clearInterval(interval);
    });

    return () => {
        localStorage.setItem('radar-socket-closed', '1');
        localStorage.removeItem('radar-socket-date');
        clearInterval(interval);
    };
}
