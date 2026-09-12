import { createContext, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
  // Sync bootstrap waits on the provider catalog. Gating children on that
  // leaves a blank terminal for seconds after the renderer has already taken over.
  blockUntilReady?: boolean
}) {
  const ctx = createContext<T>()

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const tree = <ctx.Provider value={init}>{props.children}</ctx.Provider>
      if (input.blockUntilReady === false) return tree
      return (
        // @ts-expect-error
        <Show when={init.ready === undefined || init.ready === true}>{tree}</Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
