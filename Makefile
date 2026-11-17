PYTHON ?= python3

.PHONY: test demo serve

test:
	$(PYTHON) tools/run_tests.py

demo:
	$(PYTHON) -m app.cli --data-dir data demo --reset

serve:
	$(PYTHON) -m app.cli --data-dir data serve
