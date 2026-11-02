/* Throwaway Linux prototype for ticket #9. SPDX-License-Identifier: AGPL-3.0-or-later */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(void)
{
    fputs("Session lock unavailable.\n", stderr);
    return 1;
}

int main(int argc, char **argv)
{
    if (argc != 2 || argv[1][0] != '/' || strlen(argv[1]) > 4095)
        return fail();
    char *path = strdup(argv[1]);
    if (!path)
        return fail();
    int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (parent < 0) {
        free(path);
        return fail();
    }
    /* Resolve every directory using O_NOFOLLOW; no symlinked ancestors. */
    char *cursor = path + 1;
    char *component = strsep(&cursor, "/");
    while (component && cursor) {
        if (!*component || !strcmp(component, ".") || !strcmp(component, "..")) {
            close(parent);
            free(path);
            return fail();
        }
        int next = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(parent);
        if (next < 0) {
            free(path);
            return fail();
        }
        parent = next;
        component = strsep(&cursor, "/");
    }
    if (!component || !*component || !strcmp(component, ".") || !strcmp(component, "..")) {
        close(parent);
        free(path);
        return fail();
    }
    /* NONBLOCK prevents a malicious FIFO from hanging before the type check. */
    int fd = openat(parent, component,
                    O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    close(parent);
    free(path);
    if (fd < 0)
        return fail();
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_nlink != 1 ||
        st.st_uid != geteuid() || (st.st_mode & 0777) != 0600 ||
        flock(fd, LOCK_EX | LOCK_NB)) {
        close(fd);
        return fail();
    }
    if (fputs("LOCKED\n", stdout) == EOF || fflush(stdout)) {
        close(fd);
        return fail();
    }
    char buffer[256];
    ssize_t count;
    do {
        count = read(STDIN_FILENO, buffer, sizeof(buffer));
    } while (count > 0 || (count < 0 && errno == EINTR));
    close(fd); /* Kernel also releases flock on process death. */
    return count < 0 ? fail() : 0;
}
