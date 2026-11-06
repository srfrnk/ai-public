#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdarg.h>
#include <errno.h>

static int (*real_open)(const char *pathname, int flags, ...);
static int (*real_openat)(int dirfd, const char *pathname, int flags, ...);
static int (*real_open64)(const char *pathname, int flags, ...);
static int (*real_openat64)(int dirfd, const char *pathname, int flags, ...);
static int (*real___open_2)(const char *pathname, int flags);
static int (*real___openat_2)(int dirfd, const char *pathname, int flags);
static int (*real___open64_2)(const char *pathname, int flags);
static int (*real___openat64_2)(int dirfd, const char *pathname, int flags);
static FILE *(*real_fopen)(const char *pathname, const char *mode);
static FILE *(*real_fopen64)(const char *pathname, const char *mode);

static void init_hooks(void) __attribute__((constructor));
static void init_hooks(void) {
    real_open = dlsym(RTLD_NEXT, "open");
    real_openat = dlsym(RTLD_NEXT, "openat");
    real_open64 = dlsym(RTLD_NEXT, "open64");
    real_openat64 = dlsym(RTLD_NEXT, "openat64");
    real___open_2 = dlsym(RTLD_NEXT, "__open_2");
    real___openat_2 = dlsym(RTLD_NEXT, "__openat_2");
    real___open64_2 = dlsym(RTLD_NEXT, "__open64_2");
    real___openat64_2 = dlsym(RTLD_NEXT, "__openat64_2");
    real_fopen = dlsym(RTLD_NEXT, "fopen");
    real_fopen64 = dlsym(RTLD_NEXT, "fopen64");
}

static const char *get_sanitized_target(const char *path) {
    if (!path) return NULL;
    if (strstr(path, "mountinfo")) {
        if (access("/opt/sandbox/.sanitized_mountinfo", R_OK) == 0) {
            return "/opt/sandbox/.sanitized_mountinfo";
        }
    }
    if (strstr(path, "mounts") || strstr(path, "mtab")) {
        if (access("/opt/sandbox/.sanitized_mounts", R_OK) == 0) {
            return "/opt/sandbox/.sanitized_mounts";
        }
    }
    if (strstr(path, "cmdline") && (strstr(path, "/proc") || strstr(path, "cmdline"))) {
        if (access("/opt/sandbox/.sanitized_cmdline", R_OK) == 0) {
            return "/opt/sandbox/.sanitized_cmdline";
        }
    }
    if (strstr(path, "partitions")) {
        if (access("/opt/sandbox/.sanitized_partitions", R_OK) == 0) {
            return "/opt/sandbox/.sanitized_partitions";
        }
    }
    return NULL;
}

static int is_blocked_path(const char *path) {
    if (!path) return 0;
    // Block device-mapper sysfs paths leaking host LV / VG metadata
    if (strstr(path, "/sys/dev/block/252:") || strstr(path, "/sys/class/block/dm-") || strstr(path, "/sys/devices/virtual/block/dm-")) {
        return 1;
    }
    return 0;
}

int open(const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real_open ? real_open(pathname, flags, mode) : -1;
}

int open64(const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real_open64 ? real_open64(pathname, flags, mode) : (real_open ? real_open(pathname, flags, mode) : -1);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) return real_openat ? real_openat(AT_FDCWD, target, flags, mode) : -1;
    return real_openat ? real_openat(dirfd, pathname, flags, mode) : -1;
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
    }
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) {
        return real_openat64 ? real_openat64(AT_FDCWD, target, flags, mode) : (real_openat ? real_openat(AT_FDCWD, target, flags, mode) : -1);
    }
    return real_openat64 ? real_openat64(dirfd, pathname, flags, mode) : (real_openat ? real_openat(dirfd, pathname, flags, mode) : -1);
}

int __open_2(const char *pathname, int flags) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real___open_2 ? real___open_2(pathname, flags) : (real_open ? real_open(pathname, flags) : -1);
}

int __openat_2(int dirfd, const char *pathname, int flags) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) return real___openat_2 ? real___openat_2(AT_FDCWD, target, flags) : (real_openat ? real_openat(AT_FDCWD, target, flags) : -1);
    return real___openat_2 ? real___openat_2(dirfd, pathname, flags) : (real_openat ? real_openat(dirfd, pathname, flags) : -1);
}

int __open64_2(const char *pathname, int flags) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real___open64_2 ? real___open64_2(pathname, flags) : (real_open64 ? real_open64(pathname, flags) : -1);
}

int __openat64_2(int dirfd, const char *pathname, int flags) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return -1;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) return real___openat64_2 ? real___openat64_2(AT_FDCWD, target, flags) : (real_openat64 ? real_openat64(AT_FDCWD, target, flags) : -1);
    return real___openat64_2 ? real___openat64_2(dirfd, pathname, flags) : (real_openat64 ? real_openat64(dirfd, pathname, flags) : -1);
}

FILE *fopen(const char *pathname, const char *mode) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return NULL;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real_fopen ? real_fopen(pathname, mode) : NULL;
}

FILE *fopen64(const char *pathname, const char *mode) {
    if (is_blocked_path(pathname)) {
        errno = ENOENT;
        return NULL;
    }
    const char *target = get_sanitized_target(pathname);
    if (target) pathname = target;
    return real_fopen64 ? real_fopen64(pathname, mode) : (real_fopen ? real_fopen(pathname, mode) : NULL);
}
