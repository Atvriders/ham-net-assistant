import React from 'react';
import { Input } from './ui/Input.js';

const CALLSIGN_RE = /^[A-Z0-9]{3,7}$/;

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (next: string) => void;
}

export const CallsignInput = React.forwardRef<HTMLInputElement, Props>(
  function CallsignInput({ value, onChange, ...rest }, ref) {
    const [internal, setInternal] = React.useState(value);
    React.useEffect(() => {
      setInternal(value);
    }, [value]);
    const valid = CALLSIGN_RE.test(internal);
    return (
      <Input
        ref={ref}
        {...rest}
        value={internal}
        aria-invalid={internal.length === 0 ? undefined : !valid}
        onChange={(e) => {
          const next = e.target.value.toUpperCase();
          setInternal(next);
          onChange(next);
        }}
        placeholder="W1AW"
      />
    );
  },
);
