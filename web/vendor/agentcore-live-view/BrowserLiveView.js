import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/// <reference lib="dom" />
import { useCallback, useEffect, useRef, useState } from 'react';
import dcv from 'dcv';
import { DCVViewer } from 'dcv-ui';
import { calculateScale } from './scaling.js';
const authStateMap = new Map();
let instanceCounter = 0;
const DEFAULT_REMOTE_WIDTH = 1920;
const DEFAULT_REMOTE_HEIGHT = 1080;
export const BrowserLiveView = ({ signedUrl: externalSignedUrl, remoteWidth = DEFAULT_REMOTE_WIDTH, remoteHeight = DEFAULT_REMOTE_HEIGHT, }) => {
    const cached = authStateMap.get(externalSignedUrl);
    const [dcvError, setDcvError] = useState(null);
    const [authenticated, setAuthenticated] = useState(() => cached?.authenticated ?? false);
    const [sessionId, setSessionId] = useState(() => cached?.sessionId ?? '');
    const [authToken, setAuthToken] = useState(() => cached?.authToken ?? '');
    const mountedRef = useRef(true);
    const connectionRef = useRef(null);
    const containerRef = useRef(null);
    const resizeObserverRef = useRef(null);
    const mutationObserverRef = useRef(null);
    const divIdRef = useRef(`dcv-display-${++instanceCounter}`);
    // Cleanup on unmount — disconnect DCV connection and observers
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            connectionRef.current?.disconnect();
            resizeObserverRef.current?.disconnect();
            mutationObserverRef.current?.disconnect();
        };
    }, []);
    const onPromptCredentials = useCallback(() => { }, []);
    const httpExtraSearchParamsCb = useCallback((_conn) => {
        if (!externalSignedUrl)
            return new URLSearchParams();
        return new URL(externalSignedUrl).searchParams;
    }, [externalSignedUrl]);
    const onError = useCallback((_authObj, _error) => {
        const state = authStateMap.get(externalSignedUrl);
        if (state)
            state.authenticating = false;
    }, [externalSignedUrl]);
    const onSuccess = useCallback((_, result) => {
        const resultObj = result[0] || {};
        const newSessionId = resultObj.sessionId || '';
        const newAuthToken = resultObj.authToken || '';
        authStateMap.set(externalSignedUrl, {
            authenticated: true,
            sessionId: newSessionId,
            authToken: newAuthToken,
            authenticating: false,
        });
        if (mountedRef.current) {
            setSessionId(newSessionId);
            setAuthToken(newAuthToken);
            setDcvError(null);
            setAuthenticated(true);
        }
    }, [externalSignedUrl]);
    const handleDisconnect = useCallback((_reason) => { }, []);
    const authenticate = useCallback(() => {
        const state = authStateMap.get(externalSignedUrl);
        if (!externalSignedUrl || state?.authenticating || state?.authenticated)
            return;
        authStateMap.set(externalSignedUrl, {
            authenticated: false,
            sessionId: '',
            authToken: '',
            authenticating: true,
        });
        try {
            dcv.setLogLevel(dcv.LogLevel.INFO);
            dcv.authenticate(externalSignedUrl, {
                promptCredentials: onPromptCredentials,
                error: onError,
                success: onSuccess,
                httpExtraSearchParams: httpExtraSearchParamsCb,
            });
        }
        catch (error) {
            const s = authStateMap.get(externalSignedUrl);
            if (s)
                s.authenticating = false;
            if (mountedRef.current) {
                setDcvError(`Authentication error: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
        }
    }, [externalSignedUrl, onError, onSuccess, onPromptCredentials, httpExtraSearchParamsCb]);
    // Trigger authentication when URL is ready
    useEffect(() => {
        if (!authenticated && externalSignedUrl && !dcvError)
            authenticate();
    }, [authenticated, externalSignedUrl, authenticate, dcvError]);
    const onConnectionEstablished = useCallback((conn) => {
        connectionRef.current = conn;
        let lastApplyTime = 0;
        const DEBOUNCE_MS = 100;
        const lockDisplayLayout = () => {
            try {
                conn.requestDisplayLayout?.([
                    {
                        name: 'Main Display',
                        rect: { x: 0, y: 0, width: remoteWidth, height: remoteHeight },
                        primary: true,
                    },
                ]);
            }
            catch {
                // requestDisplayLayout may not be available yet
            }
        };
        const applyScaling = () => {
            const container = containerRef.current;
            if (!container)
                return;
            const { width: w, height: h } = container.getBoundingClientRect();
            const cw = Math.floor(w);
            const ch = Math.floor(h);
            if (cw <= 0 || ch <= 0)
                return;
            lastApplyTime = Date.now();
            const dcvContainer = container.querySelector(`#${divIdRef.current}-container`);
            if (dcvContainer) {
                Object.assign(dcvContainer.style, { width: `${cw}px`, height: `${ch}px`, overflow: 'hidden' });
            }
            const dcvDisplay = container.querySelector(`#${divIdRef.current}`);
            if (dcvDisplay) {
                const { scale, offsetX } = calculateScale(cw, ch, remoteWidth, remoteHeight);
                Object.assign(dcvDisplay.style, {
                    width: `${remoteWidth}px`,
                    height: `${remoteHeight}px`,
                    transformOrigin: 'top left',
                    position: 'absolute',
                    top: '0',
                    transform: `scale(${scale})`,
                    left: `${offsetX}px`,
                });
            }
            lockDisplayLayout();
        };
        const setupMutationObserver = () => {
            const container = containerRef.current;
            const dcvDisplay = container?.querySelector(`#${divIdRef.current}`);
            if (!dcvDisplay)
                return;
            mutationObserverRef.current?.disconnect();
            mutationObserverRef.current = new MutationObserver(() => {
                if (Date.now() - lastApplyTime < DEBOUNCE_MS)
                    return;
                applyScaling();
            });
            mutationObserverRef.current.observe(dcvDisplay, { attributes: true, attributeFilter: ['style'] });
        };
        setTimeout(() => {
            applyScaling();
            setupMutationObserver();
        }, 200);
        if (containerRef.current && !resizeObserverRef.current) {
            resizeObserverRef.current = new ResizeObserver(applyScaling);
            resizeObserverRef.current.observe(containerRef.current);
        }
    }, [remoteWidth, remoteHeight]);
    if (dcvError) {
        return _jsxs("div", { style: { color: 'red', padding: '20px' }, children: ["DCV Error: ", dcvError] });
    }
    if (!authenticated)
        return null;
    return (_jsx("div", { ref: containerRef, style: { width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }, children: _jsx(DCVViewer, { dcv: {
                sessionId,
                authToken,
                serverUrl: externalSignedUrl,
                baseUrl: '/nice-dcv-web-client-sdk/dcvjs-esm',
                onDisconnect: handleDisconnect,
                onConnectionEstablished,
                logLevel: dcv.LogLevel.INFO,
                observers: { httpExtraSearchParams: httpExtraSearchParamsCb },
                divId: divIdRef.current,
            }, uiConfig: {
                toolbar: { visible: false, fullscreenButton: false, multimonitorButton: false },
            } }) }));
};
//# sourceMappingURL=BrowserLiveView.js.map