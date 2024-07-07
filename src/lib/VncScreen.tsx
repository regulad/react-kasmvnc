import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import RFB from '../noVNC/core/rfb';
import JSMpeg from '@cycjimmy/jsmpeg-player';
import type {Player} from "jsmpeg"; // doesn't exist at runtime; type-only
import MouseButtonMapper, {XVNC_BUTTONS} from "../noVNC/core/mousebuttonmapper";
import {supportsBinaryClipboard} from "../noVNC/core/util/browser";

const JSMpegVideoElement = JSMpeg.VideoElement;
const JSMpegPlayer = JSMpeg.Player || JSMpegVideoElement.player;

export interface RFBOptions {
    shared: boolean;
    credentials: {
        username?: string;
        password?: string | null;
        target?: string;
        hiDpi? : boolean;
    };
    repeaterID: string;
    wsProtocols: string | string[];
}

export interface KasmVNCRFBOptions {
    dynamicQualityMin?: number;
    dynamicQualityMax?: number;
    jpegVideoQuality?: number;
    webpVideoQuality?: number;
    videoArea?: number;
    videoTime?: number;
    videoOutTime?: number;
    videoScaling?: number;
    treatLossless?: number;
    maxVideoResolutionX?: number;
    maxVideoResolutionY?: number;
    frameRate?: number;
    idleDisconnect?: boolean;
    pointerRelative?: boolean;
    videoQuality?: number;
    antiAliasing?: number;
    clipboardUp?: boolean;
    clipboardDown?: boolean;
    clipboardSeamless?: boolean;
    enableIME?: boolean;
    clipboardBinary?: boolean;
    enableWebRTC?: boolean;
    mouseButtonMapper?: MouseButtonMapper;
    enableQOI?: boolean;
}

export interface Props {
    url: string;
    audioUrl?: string;
    style?: object;
    className?: string;
    viewOnly?: boolean;
    rfbOptions?: Partial<RFBOptions>;
    kasmOptions?: Partial<KasmVNCRFBOptions>;
    focusOnClick?: boolean;
    clipViewport?: boolean;
    dragViewport?: boolean;
    scaleViewport?: boolean;
    resizeSession?: boolean;
    showDotCursor?: boolean;
    background?: string;
    qualityLevel?: number;
    compressionLevel?: number;
    autoConnect?: boolean;
    retryDuration?: number;
    debug?: boolean;
    loadingUI?: React.ReactNode;
    onConnect?: (rfb?: RFB) => void;
    onDisconnect?: (rfb?: RFB) => void;
    onCredentialsRequired?: (rfb?: RFB) => void;
    onSecurityFailure?: (e?: { detail: { status: number, reason: string } }) => void;
    onClipboard?: (e?: { detail: { text: string } }) => void;
    onBell?: () => void;
    onDesktopName?: (e?: { detail: { name: string } }) => void;
    onCapabilities?: (e?: { detail: { capabilities: RFB["capabilities"] } }) => void;
}

export enum Events {
    connect,
    disconnect,
    credentialsrequired,
    securityfailure,
    clipboard,
    bell,
    desktopname,
    capabilities,
}

export type EventListeners = { -readonly [key in keyof typeof Events]?: (e?: any) => void };

export type VncScreenHandle = {
    connect: () => void;
    disconnect: () => void;
    connected: boolean;
    sendCredentials: (credentials: RFBOptions["credentials"]) => void;
    sendKey: (keysym: number, code: string, down?: boolean) => void;
    sendCtrlAltDel: () => void;
    focus: () => void;
    blur: () => void;
    machineShutdown: () => void;
    machineReboot: () => void;
    machineReset: () => void;
    clipboardPaste: (text: string) => void;
    rfb: RFB | null;
    jsmpegPlayer: Player | null;
    eventListeners: EventListeners;
};

const VncScreen: React.ForwardRefRenderFunction<VncScreenHandle, Props> = (props, ref) => {
    const rfb = useRef<RFB | null>(null);
    const connected = useRef<boolean>(props.autoConnect ?? true);
    const timeouts = useRef<Array<NodeJS.Timeout>>([]);
    const eventListeners = useRef<EventListeners>({});
    const screen = useRef<HTMLDivElement>(null);
    const keyboardInput = useRef<HTMLTextAreaElement>(null);
    const [loading, setLoading] = useState<boolean>(true);

    const jsmpegPlayer = useRef<Player | null>(null);
    const audioCanvasRef = useRef<HTMLCanvasElement | null>(null);

    const {
        url,
        audioUrl,
        style,
        className,
        viewOnly,
        rfbOptions,
        kasmOptions,
        focusOnClick,
        clipViewport,
        dragViewport,
        scaleViewport,
        resizeSession,
        showDotCursor,
        background,
        qualityLevel,
        compressionLevel,
        autoConnect = true,
        retryDuration = 3000,
        debug = false,
        loadingUI,
        onConnect,
        onDisconnect,
        onCredentialsRequired,
        onSecurityFailure,
        onClipboard,
        onBell,
        onDesktopName,
        onCapabilities,
    } = props;

    const logger = {
        log: (...args: any[]) => { if (debug) console.log(...args); },
        info: (...args: any[]) => { if (debug) console.info(...args); },
        error: (...args: any[]) => { if (debug) console.error(...args); },
    };

    const getRfb = () => {
        return rfb.current;
    };

    const setRfb = (_rfb: RFB | null) => {
        rfb.current = _rfb;
    };

    const getConnected = () => {
        return connected.current;
    };

    const setConnected = (state: boolean) => {
        connected.current = state;
    };

    const _onConnect = () => {
        const rfb = getRfb();
        if (onConnect) {
            onConnect(rfb ?? undefined);
            setLoading(false);
            return;
        }

        logger.info('Connected to remote VNC.');
        setLoading(false);
    };

    const _onDisconnect = () => {
        const rfb = getRfb();
        if (onDisconnect) {
            onDisconnect(rfb ?? undefined);
            setLoading(true);
            return;
        }

        const connected = getConnected();
        if (connected) {
            logger.info(`Unexpectedly disconnected from remote VNC, retrying in ${retryDuration / 1000} seconds.`);

            timeouts.current.push(setTimeout(connect, retryDuration));
        } else {
            logger.info(`Disconnected from remote VNC.`);
        }
        setLoading(true);
    };

    const _onCredentialsRequired = () => {
        const rfb = getRfb();
        if (onCredentialsRequired) {
            onCredentialsRequired(rfb ?? undefined);
            return;
        }

        // const password = rfbOptions?.credentials?.password ?? prompt("Password Required:");
        // rfb?.sendCredentials({ password: password });
    };

    const _onDesktopName = (e: { detail: { name: string } }) => {
        if (onDesktopName) {
            onDesktopName(e);
            return;
        }

        logger.info(`Desktop name is ${e.detail.name}`);
    };

    const disconnect = () => {
        if (jsmpegPlayer.current) {
            jsmpegPlayer.current.destroy();
            jsmpegPlayer.current = null;
        }

        const rfb = getRfb();
        try {
            if (!rfb) {
                return;
            }

            timeouts.current.forEach(clearTimeout);
            (Object.keys(eventListeners.current) as (keyof typeof Events)[]).forEach((event) => {
                if (eventListeners.current[event]) {
                    rfb.removeEventListener(event, eventListeners.current[event]);
                    eventListeners.current[event] = undefined;
                }
            });
            rfb.disconnect();
            setRfb(null);
            setConnected(false);

            // NOTE(roerohan): This needs to be called since the event listener is removed.
            // Even if the event listener is removed after rfb.disconnect(), the disconnect
            // event is not fired.
            _onDisconnect();
        } catch (err) {
            logger.error(err);
            setRfb(null);
            setConnected(false);
        }
    };

    function createDefaultMouseButtonMapper(): MouseButtonMapper {
        const mouseButtonMapper = new MouseButtonMapper();

        mouseButtonMapper.set(0, XVNC_BUTTONS.LEFT_BUTTON);
        mouseButtonMapper.set(1, XVNC_BUTTONS.MIDDLE_BUTTON);
        mouseButtonMapper.set(2, XVNC_BUTTONS.RIGHT_BUTTON);
        mouseButtonMapper.set(3, XVNC_BUTTONS.BACK_BUTTON);
        mouseButtonMapper.set(4, XVNC_BUTTONS.FORWARD_BUTTON);

        return mouseButtonMapper;
    }

    function initializeAudioStream() {
        // https://github.com/phoboslab/jsmpeg?tab=readme-ov-file#streaming-via-websockets

        if (!audioUrl) {
            console.log("No audio URL provided; cannot stream audio.");
            return;
        }
        if (!audioCanvasRef.current) {
            console.log("No audio canvas ref available; cannot stream audio.");
            return;
        }
        if (jsmpegPlayer.current) {
            jsmpegPlayer.current.destroy();
            jsmpegPlayer.current = null;
        }
        // we receive an MPEG-TS stream from the server
        jsmpegPlayer.current = new JSMpegPlayer(audioUrl, {
            canvas: audioCanvasRef.current,
            audio: true,
            video: false,
        });
        jsmpegPlayer.current.volume = 1;
    }

    function createRfb(): RFB {
        initializeAudioStream();

        // https://github.com/kasmtech/noVNC/blob/5ba4695e6526a27b8e38ec8d55dc33b39143e68a/app/ui.js#L1416
        const _rfb = new RFB(
          screen.current,
          keyboardInput.current,
          url,
          rfbOptions,
          true,
        );

        // global rfb
        _rfb.viewOnly = viewOnly ?? false;
        _rfb.focusOnClick = focusOnClick ?? false;
        _rfb.clipViewport = clipViewport ?? false;
        _rfb.dragViewport = dragViewport ?? false;
        _rfb.resizeSession = resizeSession ?? false;
        _rfb.scaleViewport = scaleViewport ?? false;
        _rfb.showDotCursor = showDotCursor ?? false;
        _rfb.background = background ?? '';
        _rfb.qualityLevel = qualityLevel ?? 6;
        _rfb.compressionLevel = compressionLevel ?? 2;

        // KasmVNC specific
        _rfb.dynamicQualityMin = kasmOptions?.dynamicQualityMin ?? NaN;
        _rfb.dynamicQualityMax = kasmOptions?.dynamicQualityMax ?? NaN;
        _rfb.jpegVideoQuality = kasmOptions?.jpegVideoQuality ?? NaN;
        _rfb.webpVideoQuality = kasmOptions?.webpVideoQuality ?? NaN;
        _rfb.videoArea = kasmOptions?.videoArea ?? NaN;
        _rfb.videoTime = kasmOptions?.videoTime ?? NaN;
        _rfb.videoOutTime = kasmOptions?.videoOutTime ?? NaN;
        _rfb.videoScaling = kasmOptions?.videoScaling ?? NaN;
        _rfb.treatLossless = kasmOptions?.treatLossless ?? NaN;
        _rfb.maxVideoResolutionX = kasmOptions?.maxVideoResolutionX ?? NaN;
        _rfb.maxVideoResolutionY = kasmOptions?.maxVideoResolutionY ?? NaN;
        _rfb.frameRate = kasmOptions?.frameRate ?? NaN;
        // @ts-ignore -- idleDisconnect is a property
        _rfb.idleDisconnect = kasmOptions?.idleDisconnect ?? false;
        _rfb.pointerRelative = kasmOptions?.pointerRelative ?? false;
        _rfb.videoQuality = kasmOptions?.videoQuality ?? NaN;
        _rfb.antiAliasing = kasmOptions?.antiAliasing ?? NaN;
        // @ts-ignore -- clipboardUp is a property
        _rfb.clipboardUp = kasmOptions?.clipboardUp ?? true;
        // @ts-ignore -- clipboardDown is a property
        _rfb.clipboardDown = kasmOptions?.clipboardDown ?? true;
        // @ts-ignore -- clipboardSeamless is a property
        _rfb.clipboardSeamless = kasmOptions?.clipboardSeamless ?? true;
        _rfb.keyboard.enableIME = kasmOptions?.enableIME ?? false;
        // @ts-ignore -- clipboardBinary is a property
        _rfb.clipboardBinary = supportsBinaryClipboard() && _rfb.clipboardSeamless;
        _rfb.enableWebRTC = kasmOptions?.enableWebRTC ?? false;
        if (kasmOptions?.mouseButtonMapper) {
            _rfb.mouseButtonMapper = kasmOptions.mouseButtonMapper;
        } else {
            _rfb.mouseButtonMapper = createDefaultMouseButtonMapper();
        }
        if (kasmOptions?.videoQuality === 5) {
            _rfb.enableQOI = true;
        }

        return _rfb;
    }

    const connect = () => {
        try {
            if (connected && !!rfb) {
                disconnect();
            }

            if (!screen.current) {
                return;
            }

            screen.current.innerHTML = '';
            const _rfb = createRfb();
            setRfb(_rfb);

            eventListeners.current.connect = _onConnect;
            eventListeners.current.disconnect = _onDisconnect;
            eventListeners.current.credentialsrequired = _onCredentialsRequired;
            eventListeners.current.securityfailure = onSecurityFailure;
            eventListeners.current.clipboard = onClipboard;
            eventListeners.current.bell = onBell;
            eventListeners.current.desktopname = _onDesktopName;
            eventListeners.current.capabilities = onCapabilities;

            (Object.keys(eventListeners.current) as (keyof typeof Events)[]).forEach((event) => {
                if (eventListeners.current[event]) {
                    _rfb.addEventListener(event, eventListeners.current[event]);
                }
            });

            setConnected(true);
        } catch (err) {
            logger.error(err);
        }
    };

    const sendCredentials = (credentials: RFBOptions["credentials"]) => {
        // const rfb = getRfb();
        console.error("KasmVNC does not implement credential sending")
        // rfb?.sendCredentials(credentials);
    };

    const sendKey = (keysym: number, code: string, down?: boolean) => {
        const rfb = getRfb();
        rfb?.sendKey(keysym, code, down);
    };

    const sendCtrlAltDel = () => {
        const rfb = getRfb();
        rfb?.sendCtrlAltDel();
    };

    const focus = () => {
        const rfb = getRfb();
        rfb?.focus();
    };

    const blur = () => {
        const rfb = getRfb();
        rfb?.blur();
    };

    const machineShutdown = () => {
        const rfb = getRfb();
        rfb?.machineShutdown();
    };

    const machineReboot = () => {
        const rfb = getRfb();
        rfb?.machineReboot();
    };

    const machineReset = () => {
        const rfb = getRfb();
        rfb?.machineReset();
    };

    const clipboardPaste = (text: string) => {
        const rfb = getRfb();
        rfb?.clipboardPasteFrom(text);
    };

    useImperativeHandle(ref, () => ({
        connect,
        disconnect,
        connected: connected.current,
        sendCredentials,
        sendKey,
        sendCtrlAltDel,
        focus,
        blur,
        machineShutdown,
        machineReboot,
        machineReset,
        clipboardPaste,
        rfb: rfb.current,
        jsmpegPlayer: jsmpegPlayer.current,
        eventListeners: eventListeners.current,
    }));

    useEffect(() => {
        if (autoConnect) {
            connect();
        }

        return disconnect;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleClick = () => {
        const rfb = getRfb();
        if (!rfb) return;

        rfb.focus();
    };

    const handleMouseEnter = () => {
        if (document.activeElement && document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }

        handleClick();
    };

    const handleMouseLeave = () => {
        const rfb = getRfb();
        if (!rfb) {
            return;
        }

        rfb.blur();
    };

    return (
      <>
          <div
            style={style}
            className={className}
            ref={screen}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
                <textarea autoCapitalize="off"
                          autoComplete="off" spellCheck="false" tabIndex={-1} ref={keyboardInput}/>
          </div>
          <canvas style={{width: 0, height: 0}} ref={audioCanvasRef}/>
          {loading && (loadingUI ?? <div className="text-white loading">Loading...</div>)}
      </>
    );
}

export default forwardRef(VncScreen);
