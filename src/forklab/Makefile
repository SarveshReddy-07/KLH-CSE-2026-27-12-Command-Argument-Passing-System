CC = cc
CFLAGS = -Wall -Wextra -pedantic -std=c11
TARGET = command_executor

.PHONY: all run web test clean

all: $(TARGET)

$(TARGET): main.c
	$(CC) $(CFLAGS) main.c -o $(TARGET)

run: $(TARGET)
	./$(TARGET)

web:
	python3 server.py

test: $(TARGET)
	python3 -m unittest discover -s tests -p 'test_*.py'
	node --test tests/scheduler.test.js

clean:
	rm -f $(TARGET)