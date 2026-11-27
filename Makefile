.PHONY: install samples run test clean

install:
	python3 -m pip install -r requirements.txt

samples:
	python3 -m sound_checker.samples --out samples

run:
	python3 app.py --open

test:
	python3 -m pytest -q

clean:
	rm -rf .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
