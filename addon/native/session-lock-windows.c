/* Windows session lock helper. SPDX-License-Identifier: AGPL-3.0-or-later */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static int fail(void)
{
    fputs("Session lock unavailable.\n", stderr);
    return 1;
}

/* Reject Win32 aliases, devices, alternate streams and paths with dot parts. */
static int valid_component(const wchar_t *start, size_t length)
{
    size_t i;
    static const wchar_t *const devices[] = {
        L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$", L"CLOCK$",
        L"COM1", L"COM2", L"COM3", L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9",
        L"LPT1", L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9",
        L"COM\x00b9", L"COM\x00b2", L"COM\x00b3", L"LPT\x00b9", L"LPT\x00b2", L"LPT\x00b3"
    };
    if (!length || start[length - 1] == L'.' || start[length - 1] == L' ')
        return 0;
    for (i = 0; i < length; ++i) {
        if (start[i] < 32 || wcschr(L"<>:\"/|?*", start[i])) return 0;
    }
    for (i = 0; i < sizeof(devices) / sizeof(devices[0]); ++i) {
        size_t n = wcslen(devices[i]);
        if (length >= n && !_wcsnicmp(start, devices[i], n) &&
            (length == n || start[n] == L'.')) return 0;
    }
    return 1;
}

static int valid_path(const wchar_t *path)
{
    const wchar_t *component, *cursor;
    size_t length = wcslen(path);
    if (length < 3 || length > 32760 ||
        !((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) ||
        path[1] != L':' || path[2] != L'\\') return 0;
    if (length == 3) return 1;
    component = path + 3;
    for (cursor = component; ; ++cursor) {
        if (*cursor == L'\\' || !*cursor) {
            if (!valid_component(component, (size_t)(cursor - component))) return 0;
            if (!*cursor) return 1;
            component = cursor + 1;
        }
    }
}

static PSID current_user(HANDLE *token, void **buffer)
{
    DWORD size = 0;
    TOKEN_USER *user;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) return NULL;
    GetTokenInformation(*token, TokenUser, NULL, 0, &size);
    if (!size || !(*buffer = malloc(size))) return NULL;
    if (!GetTokenInformation(*token, TokenUser, *buffer, size, &size)) return NULL;
    user = (TOKEN_USER *)*buffer;
    return user->User.Sid;
}

/* The directory ACL is owner-only and protected, the file inherits its ACE. */
static int private_acl(HANDLE file, PSID user, int directory)
{
    PSID owner = NULL;
    PACL dacl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    ACL_SIZE_INFORMATION info;
    SECURITY_DESCRIPTOR_CONTROL control;
    DWORD revision;
    ACCESS_ALLOWED_ACE *ace = NULL;
    int ok = 0;
    if (GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                        &owner, NULL, &dacl, NULL, &descriptor) != ERROR_SUCCESS) return 0;
    if (!owner || !EqualSid(owner, user) || !dacl ||
        !GetSecurityDescriptorControl(descriptor, &control, &revision) ||
        (directory && !(control & SE_DACL_PROTECTED)) ||
        !GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation) || info.AceCount != 1 ||
        !GetAce(dacl, 0, (void **)&ace) || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        ace->Mask != FILE_ALL_ACCESS || !EqualSid((PSID)&ace->SidStart, user)) goto done;
    if (directory && (ace->Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) !=
                     (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) goto done;
    ok = 1;
done:
    LocalFree(descriptor);
    return ok;
}

#ifdef MUPDF_TEST_HOST
/* Test-only Win32 host operations for Node candidate tests. They are excluded
   from the packaged helper. Product code uses Gecko's Win32 API binding. */
static int test_check_path(const wchar_t *argument, int allow_missing)
{
    wchar_t *path, *cursor;
    int result = 0;
    if (!valid_path(argument) || !(path = _wcsdup(argument))) return 0;
    for (cursor = path + 3; ; ++cursor) {
        DWORD error;
        wchar_t saved;
        HANDLE handle;
        BY_HANDLE_FILE_INFORMATION info;
        if (*cursor && *cursor != L'\\') continue;
        saved = *cursor;
        *cursor = L'\0';
        handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        *cursor = saved;
        if (handle == INVALID_HANDLE_VALUE) {
            error = GetLastError();
            result = allow_missing && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND);
            break;
        }
        if (!GetFileInformationByHandle(handle, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks != 1)) {
            CloseHandle(handle);
            break;
        }
        CloseHandle(handle);
        if (!saved) { result = 1; break; }
    }
    free(path);
    return result;
}

static int test_private_directory(const wchar_t *path, int create, int require_new)
{
    HANDLE token = NULL, directory = INVALID_HANDLE_VALUE;
    void *user_buffer = NULL;
    PSID user;
    LPWSTR sid = NULL;
    wchar_t *sddl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    SECURITY_ATTRIBUTES attributes;
    BY_HANDLE_FILE_INFORMATION info;
    size_t length;
    int result = 0;
    if (!test_check_path(path, create) || !(user = current_user(&token, &user_buffer))) goto done;
    if (create) {
        if (!ConvertSidToStringSidW(user, &sid)) goto done;
        length = 64 + 2 * wcslen(sid);
        sddl = calloc(length, sizeof(*sddl));
        if (!sddl || swprintf_s(sddl, length, L"O:%lsD:P(A;OICI;FA;;;%ls)", sid, sid) < 0 ||
            !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) goto done;
        attributes.nLength = sizeof(attributes);
        attributes.lpSecurityDescriptor = descriptor;
        attributes.bInheritHandle = FALSE;
        if (!CreateDirectoryW(path, &attributes)) {
            if (GetLastError() != ERROR_ALREADY_EXISTS || require_new) goto done;
        }
    }
    directory = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (directory == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(directory, &info) ||
        !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !private_acl(directory, user, 1)) goto done;
    result = 1;
done:
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
    if (descriptor) LocalFree(descriptor);
    if (sid) LocalFree(sid);
    if (token) CloseHandle(token);
    free(sddl);
    free(user_buffer);
    return result;
}

static int test_security_descriptor(const wchar_t *path)
{
    PSID owner = NULL, group = NULL;
    PACL dacl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    LPWSTR value = NULL;
    char *utf8 = NULL;
    int length, result = 0;
    DWORD written;
    if (!test_check_path(path, 0) ||
        GetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                              OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                              &owner, &group, &dacl, NULL, &descriptor) != ERROR_SUCCESS ||
        !ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor, SDDL_REVISION_1,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &value, NULL)) goto done;
    length = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    if (!length || !(utf8 = malloc((size_t)length)) ||
        !WideCharToMultiByte(CP_UTF8, 0, value, -1, utf8, length, NULL, NULL) ||
        !WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), utf8, (DWORD)(length - 1), &written, NULL) ||
        written != (DWORD)(length - 1)) goto done;
    result = 1;
done:
    free(utf8);
    if (value) LocalFree(value);
    if (descriptor) LocalFree(descriptor);
    return result;
}
#endif

int wmain(int argc, wchar_t **argv)
{
    HANDLE token = NULL, lock = INVALID_HANDLE_VALUE;
    HANDLE *parents = NULL;
    size_t parent_count = 0, i;
    wchar_t *path = NULL, *cursor;
    void *user_buffer = NULL;
    PSID user;
    LPWSTR user_sid = NULL;
    PSECURITY_DESCRIPTOR lock_descriptor = NULL;
    SECURITY_ATTRIBUTES lock_attributes;
    wchar_t lock_sddl[512];
    BY_HANDLE_FILE_INFORMATION info;
    OVERLAPPED overlap = {0};
    DWORD count, error;
    int result = 1;
    char buffer[256];

#ifdef MUPDF_TEST_HOST
    if (argc == 4 && !wcscmp(argv[1], L"--test-check-path"))
        return test_check_path(argv[2], !wcscmp(argv[3], L"allow-missing")) ? 0 : fail();
    if (argc == 4 && !wcscmp(argv[1], L"--test-ensure-private-directory"))
        return test_private_directory(argv[2], 1, !wcscmp(argv[3], L"new")) ? 0 : fail();
    if (argc == 3 && !wcscmp(argv[1], L"--test-verify-private-directory"))
        return test_private_directory(argv[2], 0, 0) ? 0 : fail();
    if (argc == 4 && !wcscmp(argv[1], L"--test-replace-file"))
        return test_check_path(argv[2], 0) && test_check_path(argv[3], 0) &&
               ReplaceFileW(argv[2], argv[3], NULL, 0, NULL, NULL) ? 0 : fail();
    if (argc == 3 && !wcscmp(argv[1], L"--test-security-descriptor"))
        return test_security_descriptor(argv[2]) ? 0 : fail();
#endif
    if (argc != 2 || !valid_path(argv[1])) return fail();
    path = _wcsdup(argv[1]);
    parents = calloc(wcslen(argv[1]) + 1, sizeof(*parents));
    if (!path || !parents || !(user = current_user(&token, &user_buffer))) goto done;

    /* Hold every parent open without delete sharing until the lock is released.
       This prevents a checked directory from being renamed into a redirection. */
    for (cursor = path + 3; *cursor; ++cursor) {
        HANDLE parent;
        if (*cursor != L'\\') continue;
        *cursor = L'\0';
        parent = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
        *cursor = L'\\';
        if (parent == INVALID_HANDLE_VALUE) goto done;
        parents[parent_count++] = parent;
        if (!GetFileInformationByHandle(parent, &info) ||
            !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
            (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) goto done;
    }
    if (!parent_count || !private_acl(parents[parent_count - 1], user, 1) ||
        !ConvertSidToStringSidW(user, &user_sid) ||
        swprintf_s(lock_sddl, sizeof(lock_sddl) / sizeof(lock_sddl[0]),
                   L"O:%lsD:P(A;;FA;;;%ls)", user_sid, user_sid) < 0 ||
        !ConvertStringSecurityDescriptorToSecurityDescriptorW(lock_sddl, SDDL_REVISION_1,
                                                               &lock_descriptor, NULL)) goto done;
    lock_attributes.nLength = sizeof(lock_attributes);
    lock_attributes.lpSecurityDescriptor = lock_descriptor;
    lock_attributes.bInheritHandle = FALSE;
    lock = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                       FILE_SHARE_READ | FILE_SHARE_WRITE, &lock_attributes, OPEN_ALWAYS,
                       FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (lock == INVALID_HANDLE_VALUE || GetFileType(lock) != FILE_TYPE_DISK ||
        !GetFileInformationByHandle(lock, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
        info.nNumberOfLinks != 1 || !private_acl(lock, user, 0) ||
        !LockFileEx(lock, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0, 1, 0, &overlap)) goto done;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "LOCKED\n", 7, &count, NULL) || count != 7) goto done;
    for (;;) {
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &count, NULL)) {
            error = GetLastError();
            if (error != ERROR_BROKEN_PIPE && error != ERROR_HANDLE_EOF) goto done;
            break;
        }
        if (!count) break;
    }
    result = 0;
done:
    if (lock != INVALID_HANDLE_VALUE) CloseHandle(lock);
    if (lock_descriptor) LocalFree(lock_descriptor);
    if (user_sid) LocalFree(user_sid);
    for (i = 0; i < parent_count; ++i) CloseHandle(parents[i]);
    if (token) CloseHandle(token);
    free(user_buffer);
    free(parents);
    free(path);
    return result ? fail() : 0;
}
