declare const process: { env: Record<string, string | undefined> };

declare module 'react' {
  export type SetStateAction<S> = S | ((prevState: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export function useState<T>(initial: T): [T, Dispatch<SetStateAction<T>>];
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export type PropsWithChildren<P = unknown> = P & { children?: unknown };
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}

declare module 'react-native' {
  export const Alert: { alert: (...args: any[]) => void };
  export const Pressable: any;
  export const SafeAreaView: any;
  export const ScrollView: any;
  export const StatusBar: any;
  export const StyleSheet: { create: <T>(styles: T) => T };
  export const Switch: any;
  export const Text: any;
  export const TextInput: any;
  export const View: any;
}
