PYTHON ?= python3

.PHONY: run test

run:
	$(PYTHON) -m workbench

test:
	$(PYTHON) -m unittest discover -s tests -t . -v
