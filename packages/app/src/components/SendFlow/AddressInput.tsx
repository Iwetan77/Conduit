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
      <label className="text-xs font-mono text-brand-muted uppercase tracking-wider">
        Recipient Address
      </label>
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder ?? "0x..."}
          className={`w-full px-4 py-3 rounded-xl font-mono text-sm
                       bg-brand-surface border transition-colors outline-none
                       text-brand-white placeholder:text-brand-muted
                       ${showError
                         ? "border-red-500/50 focus:border-red-500"
                         : value && isValid
                         ? "border-brand-green/50 focus:border-brand-green"
                         : "border-brand-border focus:border-brand-white/30"
                       }`}
          spellCheck={false}
          autoComplete="off"
        />
        {value && isValid && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-green text-sm">
            ✓
          </span>
        )}
      </div>
      {showError && (
        <p className="text-xs text-red-400 font-mono">Invalid Ethereum address</p>
      )}
    </div>
  );
}
