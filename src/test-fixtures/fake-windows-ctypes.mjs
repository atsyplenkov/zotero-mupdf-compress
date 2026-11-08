/* SPDX-License-Identifier: AGPL-3.0-or-later */

// Model the CData pointer operations used by the Gecko binding. This is not a
// substitute for executing Gecko's actual js-ctypes implementation on Windows.
export function windowsCtypes({ replaceFails = false } = {}) {
  const sid = "S-1-5-21-100-200-300-1001";
  const entries = new Map([
    ["C:\\", { attributes: 0x10 }],
    ["C:\\Users", { attributes: 0x10 }],
    ["C:\\Users\\Zoë", { attributes: 0x10 }],
  ]);
  const created = [];
  const replacements = [];
  const moves = [];
  const deleted = [];
  let lastError = 0;
  const pointer = (value = null) => ({
    value,
    address() { return this; },
    isNull() { return this.value === null; },
    readString() { return this.value; },
    toString() { return String(this.value); },
  });
  pointer.ptr = {};
  const scalar = (value = 0) => pointer(value);
  scalar.ptr = {};
  const ctypes = {
    winapi_abi: {}, uint32_t: scalar, uint16_t: scalar, int32_t: scalar, uint8_t: scalar,
    voidptr_t: pointer, jschar: { ptr: pointer }, intptr_t: scalar,
    get winLastError() { return lastError; },
    StructType(name) {
      const type = () => ({
        address() { return this; },
        attributes: 0, links: 0,
      });
      type.size = 24;
      type.ptr = { name };
      return type;
    },
    ArrayType(_type, length) {
      return () => Object.assign(new Uint8Array(length), { address() { return this; } });
    },
    cast(value, target) {
      if (target?.name === "TOKEN_USER") return { contents: { User: { Sid: pointer(sid) } } };
      return value;
    },
    open() {
      return {
        close() {},
        declare(name) {
          const methods = {
            GetFileAttributesW(path) {
              const entry = entries.get(path);
              if (!entry) { lastError = 2; return 0xffffffff; }
              return entry.attributes;
            },
            CreateFileW(path, _access, _share, attributes, disposition) {
              let entry = entries.get(path);
              if (disposition === 1 && !entry) {
                entry = { attributes: 0, sddl: attributes.lpSecurityDescriptor.value, bytes: Buffer.alloc(0) };
                entries.set(path, entry);
              } else if (disposition === 1) return pointer(-1);
              const handle = pointer(entry ? path : -1);
              handle.offset = 0;
              return handle;
            },
            ReadFile(handle, buffer, _length, received) {
              const entry = entries.get(handle.value);
              const bytes = entry.bytes.subarray(handle.offset, handle.offset + buffer.length);
              buffer.set(bytes);
              received.value = bytes.length;
              handle.offset += bytes.length;
              return 1;
            },
            WriteFile(handle, buffer, length, written) {
              const entry = entries.get(handle.value);
              entry.privateBeforeWrite = entry.sddl === `O:${sid}D:P(A;;FA;;;${sid})`;
              entry.bytes = Buffer.concat([entry.bytes, Buffer.from(buffer.subarray(0, length))]);
              written.value = length;
              return 1;
            },
            GetFileInformationByHandle(handle, info) {
              const entry = entries.get(handle.value);
              if (!entry) return 0;
              info.attributes = entry.attributes;
              info.links = entry.links ?? 1;
              return 1;
            },
            CloseHandle: () => 1,
            GetCurrentProcess: () => pointer("process"),
            OpenProcessToken(_process, _access, output) { output.value = "token"; return 1; },
            GetTokenInformation(_token, _kind, _buffer, _size, size) { size.value = 32; return 1; },
            ConvertSidToStringSidW(_sid, output) { output.value = sid; return 1; },
            ConvertStringSecurityDescriptorToSecurityDescriptorW(input, _revision, output) {
              output.value = input;
              return 1;
            },
            ConvertSecurityDescriptorToStringSecurityDescriptorW(input, _revision, _flags, output) {
              output.value = input.value;
              return 1;
            },
            GetNamedSecurityInfoW(path, _objectType, _flags, owner, group, dacl, _sacl, output) {
              const entry = entries.get(path);
              if (!entry) return 2;
              owner.value = "owner";
              if (group) group.value = "group";
              dacl.value = entry.sddl;
              output.value = entry.sddl;
              return 0;
            },
            MoveFileExW(source, destination, flags) {
              moves.push({ source, destination, flags });
              if (!entries.has(source) || entries.has(destination) || flags !== 0) return 0;
              entries.set(destination, entries.get(source));
              entries.delete(source);
              return 1;
            },
            DeleteFileW(path) {
              deleted.push(path);
              return Number(entries.delete(path));
            },
            ReplaceFileW(original, replacement, backup, flags) {
              replacements.push({ original, replacement, backup, flags });
              if (replaceFails) return 0;
              const previous = entries.get(original);
              const next = entries.get(replacement);
              let sddl = previous.sddl;
              const parent = (path) => path.slice(0, path.lastIndexOf("\\"));
              // The native regression loses inherited ACEs when merging in the private parent.
              if (parent(original) !== parent(replacement) && !sddl.includes("D:P")) {
                const inherited = /\([^;]+;[^;]*ID[^;]*;[^)]*\)/g;
                sddl = sddl.replace(inherited, "") + (next.sddl.match(inherited) || []).join("");
              }
              entries.set(original, { ...next, sddl });
              entries.delete(replacement);
              return 1;
            },
            CreateDirectoryW(path, attributes) {
              if (entries.has(path)) { lastError = 183; return 0; }
              entries.set(path, { attributes: 0x10, sddl: attributes.lpSecurityDescriptor.value });
              created.push(path);
              return 1;
            },
            LocalFree: () => pointer(),
          };
          if (!(name in methods)) throw new Error(`Unexpected Win32 call: ${name}`);
          return methods[name];
        },
      };
    },
  };
  return { ctypes, entries, created, replacements, moves, deleted, sid };
}
