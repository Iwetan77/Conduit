import { create } from "zustand";
import type { PaymentDeclaration, PaymentReceipt, Currency } from "@conduit/sdk";

interface ConduitStore {
  // Active declarations the connected wallet created
  declarations: PaymentDeclaration[];
  setDeclarations: (declarations: PaymentDeclaration[]) => void;
  addDeclaration: (declaration: PaymentDeclaration) => void;
  removeDeclaration: (declarationId: string) => void;

  // Transaction history
  history: PaymentReceipt[];
  setHistory: (history: PaymentReceipt[]) => void;
  addReceipt: (receipt: PaymentReceipt) => void;

  // Active send flow
  sendFlow: {
    recipient: string;
    amount: string;
    currency: Currency;
    step: "input" | "preview" | "confirm" | "success";
  };
  setSendFlow: (flow: Partial<ConduitStore["sendFlow"]>) => void;
  resetSendFlow: () => void;

  // Active create flow
  createFlow: {
    amount: string;
    currency: Currency;
    label: string;
    step: "form" | "output";
    result: { declarationId: string; paymentUrl: string } | null;
  };
  setCreateFlow: (flow: Partial<ConduitStore["createFlow"]>) => void;
  resetCreateFlow: () => void;
}

const defaultSendFlow: ConduitStore["sendFlow"] = {
  recipient: "",
  amount: "",
  currency: "USDC",
  step: "input",
};

const defaultCreateFlow: ConduitStore["createFlow"] = {
  amount: "",
  currency: "USDC",
  label: "",
  step: "form",
  result: null,
};

export const useConduitStore = create<ConduitStore>((set) => ({
  declarations: [],
  setDeclarations: (declarations) => set({ declarations }),
  addDeclaration: (declaration) =>
    set((state) => ({ declarations: [declaration, ...state.declarations] })),
  removeDeclaration: (declarationId) =>
    set((state) => ({
      declarations: state.declarations.filter((d) => d.declarationId !== declarationId),
    })),

  history: [],
  setHistory: (history) => set({ history }),
  addReceipt: (receipt) =>
    set((state) => ({ history: [receipt, ...state.history] })),

  sendFlow: defaultSendFlow,
  setSendFlow: (flow) =>
    set((state) => ({ sendFlow: { ...state.sendFlow, ...flow } })),
  resetSendFlow: () => set({ sendFlow: defaultSendFlow }),

  createFlow: defaultCreateFlow,
  setCreateFlow: (flow) =>
    set((state) => ({ createFlow: { ...state.createFlow, ...flow } })),
  resetCreateFlow: () => set({ createFlow: defaultCreateFlow }),
}));
