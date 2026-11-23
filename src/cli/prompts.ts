import {
  cancel as clackCancel,
  confirm as clackConfirm,
  intro as clackIntro,
  isCancel,
  multiselect as clackMultiselect,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  spinner as clackSpinner,
} from "@clack/prompts";
import type { CommonOptions, MultiSelectOptions, SelectOptions } from "@clack/prompts";
import type { Readable, Writable } from "node:stream";

export interface PromptAdapter {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  multiselect<T>(options: {
    message: string;
    options: readonly { value: T; label: string; hint?: string }[];
    initialValues?: readonly T[];
  }): Promise<readonly T[] | null>;
  select<T>(options: {
    message: string;
    options: readonly { value: T; label: string; hint?: string }[];
    initialValue?: T;
  }): Promise<T | null>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | null>;
  spinner<T>(message: string, work: () => Promise<T>): Promise<T>;
}

function mapOptions<T>(
  options: readonly { value: T; label: string; hint?: string }[],
): { value: T; label: string; hint?: string }[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.hint === undefined ? {} : { hint: option.hint }),
  }));
}

export function createClackAdapter(
  output: NodeJS.WritableStream,
  input?: NodeJS.ReadStream,
): PromptAdapter {
  //* Every primitive receives both streams so callers can keep stdout free of prompts.
  //* The casts bridge NodeJS.WritableStream/ReadStream to clack's node:stream types.
  const common = (): CommonOptions =>
    ({
      output: output as unknown as Writable,
      input: input as unknown as Readable | undefined,
    }) as unknown as CommonOptions;

  const cancelled = (): null => {
    clackCancel("Cancelled", common());
    return null;
  };

  return {
    intro(message: string): void {
      clackIntro(message, common());
    },

    outro(message: string): void {
      clackOutro(message, common());
    },

    note(message: string, title?: string): void {
      clackNote(message, title, common());
    },

    async multiselect<T>(options: {
      message: string;
      options: readonly { value: T; label: string; hint?: string }[];
      initialValues?: readonly T[];
    }): Promise<readonly T[] | null> {
      const result = await clackMultiselect<T>({
        ...common(),
        message: options.message,
        options: mapOptions(options.options) as unknown as MultiSelectOptions<T>["options"],
        ...(options.initialValues === undefined ? {} : { initialValues: options.initialValues }),
      });
      return isCancel(result) ? cancelled() : result;
    },

    async select<T>(options: {
      message: string;
      options: readonly { value: T; label: string; hint?: string }[];
      initialValue?: T;
    }): Promise<T | null> {
      const result = await clackSelect<T>({
        ...common(),
        message: options.message,
        options: mapOptions(options.options) as unknown as SelectOptions<T>["options"],
        ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      });
      return isCancel(result) ? cancelled() : result;
    },

    async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | null> {
      const result = await clackConfirm({
        ...common(),
        message: options.message,
        ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      });
      return isCancel(result) ? cancelled() : result;
    },

    spinner<T>(message: string, work: () => Promise<T>): Promise<T> {
      const spin = clackSpinner(common());
      spin.start(message);
      return (async () => {
        try {
          const value = await work();
          spin.stop();
          return value;
        } catch (error) {
          spin.error();
          throw error;
        }
      })();
    },
  };
}
