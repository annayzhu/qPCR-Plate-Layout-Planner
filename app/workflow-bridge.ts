import { useEffect, useRef } from 'react';
export type WorkflowContext = {
    sessionId: string;
    state?: unknown;
    samples?: Array<{
        id: string;
        name: string;
        comparisonGroup?: string;
        kind: 'sample';
    }>;
    layouts?: Array<{
        id: string;
        revision: number;
        sessionAttachmentId: string;
    }>;
    title?: string;
    language?: 'zh' | 'en';
};
// Inside LabNest the host provides the title row, so the tool drops its own name.
if (typeof window !== 'undefined' && window.parent !== window)
    document.documentElement.dataset.labnestHosted = 'true';
export function useWorkflowBridge(state: unknown, restore: (context: WorkflowContext) => void, output: () => unknown | Promise<unknown>) {
    const callbacks = useRef({ state, restore, output });
    callbacks.current = { state, restore, output };
    const sessionId = useRef('');
    useEffect(() => {
        if (window.parent === window)
            return;
        const send = (message: object) => window.parent.postMessage({ protocol: 'labnest-tool-v1', sessionId: sessionId.current, ...message }, window.location.origin);
        const receive = async (event: MessageEvent) => {
            if (event.origin !== location.origin || event.source !== window.parent || event.data?.protocol !== 'labnest-tool-v1')
                return;
            if (event.data.type === 'CONTEXT_INIT') {
                sessionId.current = event.data.sessionId;
                document.documentElement.dataset.labnestEmbedded = 'true';
                let state = event.data.state;
                if (!state)
                    try {
                        state = JSON.parse(localStorage.getItem(`labnest-qpcr:${sessionId.current}`) ?? 'null');
                    }
                    catch { }
                try {
                    callbacks.current.restore({ ...event.data, state });
                    send({ type: 'CONTEXT_READY' });
                }
                catch (error) {
                    send({ type: 'SAVE_ERROR', error: error instanceof Error ? error.message : '方案读取失败' });
                }
            }
            if (event.data.type === 'REQUEST_DRAFT' && event.data.sessionId === sessionId.current)
                send({ type: 'DRAFT_FLUSH', state: callbacks.current.state });
            if (event.data.type === 'REQUEST_OUTPUT' && event.data.sessionId === sessionId.current)
                try {
                    const output = await callbacks.current.output();
                    send({ type: 'OUTPUT_SUBMIT', state: callbacks.current.state, output });
                }
                catch (error) {
                    send({ type: 'SAVE_ERROR', error: error instanceof Error ? error.message : '请检查当前输入' });
                }
        };
        window.addEventListener('message', receive);
        send({ type: 'TOOL_READY' });
        return () => window.removeEventListener('message', receive);
    }, []);
    useEffect(() => {
        if (!sessionId.current)
            return;
        const timer = setTimeout(() => { try {
            localStorage.setItem(`labnest-qpcr:${sessionId.current}`, JSON.stringify(state));
            window.parent.postMessage({ protocol: 'labnest-tool-v1', type: 'DRAFT_CHANGED', sessionId: sessionId.current, state }, location.origin);
        }
        catch { } }, 250);
        return () => clearTimeout(timer);
    }, [state]);
}
