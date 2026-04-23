declare const process: { env: Record<string, string | undefined> };

declare module 'react' {
  export type SetStateAction<S> = S | ((prevState: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export function useState<T>(initial: T): [T, Dispatch<SetStateAction<T>>];
  export function useRef<T>(initial: T): { current: T };
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export function useCallback<T>(callback: T, deps: unknown[]): T;
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export type PropsWithChildren<P = unknown> = P & { children?: unknown };
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}

declare module 'react-native' {
  export const ActivityIndicator: any;
  export const Alert: { alert: (...args: any[]) => void };
  export type ImageSourcePropType = number | { uri: string; headers?: Record<string, string> };
  export const Image: any;
  export const KeyboardAvoidingView: any;
  export const Pressable: any;
  export const Platform: { OS: string };
  export const SafeAreaView: any;
  export const ScrollView: any;
  export const StatusBar: any;
  export const StyleSheet: { create: <T>(styles: T) => T };
  export const Switch: any;
  export const Text: any;
  export const TextInput: any;
  export function useWindowDimensions(): { width: number; height: number; scale: number; fontScale: number };
  export const View: any;
}

declare module 'react-native-safe-area-context' {
  export const SafeAreaProvider: any;
  export const SafeAreaView: any;
  export function useSafeAreaInsets(): { top: number; bottom: number; left: number; right: number };
}
