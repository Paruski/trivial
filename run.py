import argparse
import os

from server.api import run


def main():
    parser = argparse.ArgumentParser(prog="trivial-server")
    parser.add_argument("--host", default=os.getenv("TRIVIAL_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("TRIVIAL_PORT", "8080")))
    parser.add_argument("--database", default=os.getenv("TRIVIAL_DATABASE"))
    arguments = parser.parse_args()
    run(arguments.host, arguments.port, arguments.database)


if __name__ == "__main__":
    main()
