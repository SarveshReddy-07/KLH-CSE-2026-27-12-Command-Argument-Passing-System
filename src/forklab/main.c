#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>

#define MAX_INPUT 200
#define MAX_ARGS 20
#define MAX_STAGES 8
#define MAX_STAGE_ARGS 64

struct stage
{
    char *input;
    char *output;
    int append;
    char *args[MAX_STAGE_ARGS + 1];
};

static int wait_for_child(pid_t pid, int *signaled)
{
    int status;
    while (waitpid(pid, &status, 0) < 0)
    {
        if (errno != EINTR)
        {
            perror("[Parent] waitpid failed");
            return 1;
        }
    }
    if (signaled != NULL)
    {
        *signaled = WIFSIGNALED(status);
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static int parse_number(const char *text, int minimum, int maximum)
{
    char *end;
    long value = strtol(text, &end, 10);
    if (*text == '\0' || *end != '\0' || value < minimum || value > maximum)
    {
        return -1;
    }
    return (int)value;
}

static int execute_pipeline(int argc, char *argv[])
{
    struct stage stages[MAX_STAGES];
    int pipes[MAX_STAGES - 1][2];
    pid_t children[MAX_STAGES];
    int count = argc > 2 ? parse_number(argv[2], 1, MAX_STAGES) : -1;
    int position = 3;

    if (count < 0)
    {
        fprintf(stderr, "[Parent] Invalid pipeline stage count.\n");
        return 2;
    }
    for (int i = 0; i < count; i++)
    {
        if (position + 4 > argc)
        {
            fprintf(stderr, "[Parent] Incomplete pipeline specification.\n");
            return 2;
        }
        int size = parse_number(argv[position++], 1, MAX_STAGE_ARGS);
        stages[i].input = argv[position++];
        stages[i].output = argv[position++];
        stages[i].append = parse_number(argv[position++], 0, 1);
        if (size < 0 || stages[i].append < 0 || position + size > argc)
        {
            fprintf(stderr, "[Parent] Invalid pipeline arguments.\n");
            return 2;
        }
        for (int j = 0; j < size; j++)
        {
            stages[i].args[j] = argv[position++];
        }
        stages[i].args[size] = NULL;
    }
    if (position != argc)
    {
        fprintf(stderr, "[Parent] Unexpected pipeline arguments.\n");
        return 2;
    }

    for (int i = 0; i < count - 1; i++)
    {
        if (pipe(pipes[i]) < 0)
        {
            perror("[Parent] pipe failed");
            for (int j = 0; j < i; j++)
            {
                close(pipes[j][0]);
                close(pipes[j][1]);
            }
            return 1;
        }
        fprintf(stderr, "[Parent] pipe() created channel %d.\n", i + 1);
    }
    fprintf(stderr, "[Parent] Parent PID : %d\n", getpid());
    fflush(stderr);

    int spawned = 0;
    for (int i = 0; i < count; i++)
    {
        pid_t pid = fork();
        if (pid < 0)
        {
            perror("[Parent] fork failed");
            break;
        }
        if (pid == 0)
        {
            if ((i > 0 && dup2(pipes[i - 1][0], STDIN_FILENO) < 0) ||
                (i < count - 1 && dup2(pipes[i][1], STDOUT_FILENO) < 0))
            {
                perror("[Child] dup2 failed");
                _exit(1);
            }
            for (int j = 0; j < count - 1; j++)
            {
                close(pipes[j][0]);
                close(pipes[j][1]);
            }
            if (stages[i].input[0] != '\0')
            {
                int fd = open(stages[i].input, O_RDONLY);
                if (fd < 0 || dup2(fd, STDIN_FILENO) < 0)
                {
                    perror("[Child] Input redirection failed");
                    _exit(1);
                }
                close(fd);
            }
            if (stages[i].output[0] != '\0')
            {
                int flags = O_WRONLY | O_CREAT | (stages[i].append ? O_APPEND : O_TRUNC);
                int fd = open(stages[i].output, flags, 0666);
                if (fd < 0 || dup2(fd, STDOUT_FILENO) < 0)
                {
                    perror("[Child] Output redirection failed");
                    _exit(1);
                }
                close(fd);
            }
            fprintf(stderr, "[Child] Stage %d PID : %d; execvp(%s)\n",
                    i + 1, getpid(), stages[i].args[0]);
            fflush(stderr);
            execvp(stages[i].args[0], stages[i].args);
            perror("[Child] Command failed");
            _exit(127);
        }
        children[spawned++] = pid;
        fprintf(stderr, "[Parent] Child PID : %d (stage %d)\n", pid, i + 1);
    }
    for (int i = 0; i < count - 1; i++)
    {
        close(pipes[i][0]);
        close(pipes[i][1]);
    }
    if (spawned != count)
    {
        for (int i = 0; i < spawned; i++)
        {
            if (kill(children[i], SIGKILL) < 0 && errno != ESRCH)
            {
                perror("[Parent] Could not stop child");
            }
        }
    }
    int result = 1;
    for (int i = 0; i < spawned; i++)
    {
        int status = wait_for_child(children[i], NULL);
        fprintf(stderr, "[Parent] Child %d completed with status %d.\n", children[i], status);
        result = status;
    }
    return spawned == count ? result : 1;
}

int execute_command(char *args[])
{
    fprintf(stderr, "[Parent] Creating child process...\n");
    fflush(stderr);

    pid_t pid = fork();

    if (pid < 0)
    {
        perror("[Parent] Fork failed");
        return 1;
    }

    if (pid == 0)
    {
        fprintf(stderr, "----------------------------------------\n");
        fprintf(stderr, "[Child] Child process created\n");
        fprintf(stderr, "[Child] PID  : %d\n", getpid());
        fprintf(stderr, "[Child] PPID : %d\n", getppid());
        fprintf(stderr, "[Child] Executing: ");

        for (int index = 0; args[index] != NULL; index++)
        {
            fprintf(stderr, "%s%s", index == 0 ? "" : " ", args[index]);
        }

        fprintf(stderr, "\n----------------------------------------\n");
        fflush(stderr);

        execvp(args[0], args);

        perror("[Child] Command failed");
        _exit(127);
    }

    fprintf(stderr, "[Parent] Parent PID : %d\n", getpid());
    fprintf(stderr, "[Parent] Child PID  : %d\n", pid);
    fprintf(stderr, "[Parent] Waiting for child...\n\n");
    fflush(stderr);

    int signaled = 0;
    int status = wait_for_child(pid, &signaled);
    if (signaled)
    {
        fprintf(stderr, "\n[Parent] Child %d ended unexpectedly.\n", pid);
        return 1;
    }
    fprintf(stderr, "\n[Parent] Child %d completed with status %d.\n", pid, status);
    return status;
}

int main(int argc, char *argv[])
{
    char input[MAX_INPUT];
    char *args[MAX_ARGS];

    if (argc > 1 && strcmp(argv[1], "--pipeline-v2") == 0)
    {
        return execute_pipeline(argc, argv);
    }
    // Web/server mode: execute arguments once and finish.
    if (argc > 1)
    {
        return execute_command(&argv[1]);
    }

    while (1)
    {
        printf("\nOS> ");
        fflush(stdout);

        // Read command from user
        if (fgets(input, sizeof(input), stdin) == NULL)
        {
            break;
        }

        // Remove newline
        input[strcspn(input, "\n")] = '\0';

        // Ignore empty input
        if (strlen(input) == 0)
        {
            continue;
        }

        // Exit command
        if (strcmp(input, "exit") == 0)
        {
            printf("\nParent process exiting...\n");
            break;
        }

        // Convert input into arguments
        int count = 0;

        char *token = strtok(input, " ");

        while (token != NULL && count < MAX_ARGS - 1)
        {
            args[count] = token;
            count++;

            token = strtok(NULL, " ");
        }

        args[count] = NULL;
        if (count == 0)
        {
            continue;
        }

        printf("\n");
        execute_command(args);
        printf("[Parent] Ready for next command.\n");
    }

    return 0;
}