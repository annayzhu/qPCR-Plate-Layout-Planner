import { useId, useLayoutEffect, useRef, useState } from 'react';

/** Keep the editable name and the full, wrapped value readable at every width. */
export function WellNameInput({ label, value, list, placeholder, onChange }: {
    label: string;
    value: string;
    list: string;
    placeholder: string;
    onChange: (value: string) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const descriptionId = useId();
    const [overflows, setOverflows] = useState(false);
    useLayoutEffect(() => {
        const element = input.current;
        if (!element) return;
        const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        measure();
        return () => observer.disconnect();
    }, [value]);
    return <>
      <input ref={input} className="input" list={list} autoComplete="off" maxLength={200}
        aria-label={label} aria-describedby={overflows ? descriptionId : undefined}
        value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
      {overflows && <span id={descriptionId} className="manual-well-full-name">{value}</span>}
    </>;
}
