"use client";

import { useState } from "react";
import { isAddress } from "viem";

interface AddressInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function AddressInput({ value, onChange, placeholder }: AddressInputProps) {
  const [touched, setTouched] = useState(false);
  const isValid = !value || isAddress(value);
  const showError = touched && value && !isValid;

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-mono text-ink-dim uppercase tracking-wider">
        Recipient Address
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder ?? "0x..."}
          className={`w-full px-4 py-3 font-mono text-sm
                       bg-surface border transition-colors outline-none
                       text-ink placeholder:text-ink-dim
                       ${showError
                         ? "border-danger/50 focus:border-danger"
                         : value && isValid
                         ? "border-signal/50 focus:border-signal"
                         : "border-border focus:border-ink-dim/30"
                       }`}
          spellCheck={false}
          autoComplete="off"
        />
        {value && isValid && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-signal text-sm">
            ✓
          </span>
        )}
      </div>
      {showError && (
        <p className="text-xs text-danger font-mono">Invalid Ethereum address</p>
      )}
    </div>
  );
}
